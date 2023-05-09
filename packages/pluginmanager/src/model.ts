import { JupyterLab } from '@jupyterlab/application';
import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';
import { VDomModel } from '@jupyterlab/ui-components';
import { ISignal, Signal } from '@lumino/signaling';
import { PromiseDelegate } from '@lumino/coreutils';

/**
 * The server API path for querying/modifying available plugins.
 */
const PLUGIN_API_PATH = 'lab/api/plugins';

/**
 * Extension actions that the server API accepts.
 */
export type Action = 'enable' | 'disable';

/**
 * Information about a plugin.
 */
export interface IEntry extends JupyterLab.IPluginInfo {
  /**
   * TODO: how to handle system (core) plugins?
   */

  /**
   * Whether the plugin is locked (cannot be enabled/disabled).
   *
   * Administrators can lock plugins preventing users from introducing modifications.
   * The check is performed on the server side, this field is only to show users
   * an indicator of the lock status.
   */
  locked: boolean;
}

/**
 * An object representing a server reply to performing an action.
 */
export interface IActionReply {
  /**
   * The status category of the reply.
   */
  status: 'ok' | 'warning' | 'error' | null;

  /**
   * An optional message when the status is not 'ok'.
   */
  message?: string;
}

/**
 * Server-side plugin manager metadata
 */
export interface IPluginManagerMetadata {
  /**
   * Whether the plugin manager can enable/disable plugins.
   */
  can_modify: boolean;
}

export namespace PluginListModel {
  export interface IConfigurableState {
    query?: string;
  }
  export interface IOptions extends IConfigurableState {
    app: JupyterLab;
    serverMetadata?: IPluginManagerMetadata;
    serverSettings?: ServerConnection.ISettings;
  }
}

export class PluginListModel extends VDomModel {
  constructor(options: PluginListModel.IOptions) {
    super();
    this._app = options.app;
    this._serverSettings =
      options.serverSettings || ServerConnection.makeSettings();
    this._query = options.query || '';
    // The page config option may not be defined; e.g. in the federated example
    const metadata = options.serverMetadata || { can_modify: false };
    this.canModify = metadata.can_modify;
    this.refresh()
      .then(() => this._ready.resolve())
      .catch(e => this._ready.reject(e));
  }

  private _app: JupyterLab;
  readonly canModify: boolean;
  readonly isDisclaimed = true; // TODO

  get available(): ReadonlyArray<IEntry> {
    return this._available;
  }

  /**
   * Contains an error message if an error occurred when querying available packages.
   */
  availableError: string | null = null;

  get isLoading(): boolean {
    return this._isLoading;
  }

  /**
   * Enable a plugin.
   *
   * @param entry An entry indicating which plugin to enable.
   */
  async enable(entry: IEntry): Promise<void> {
    if (entry.enabled) {
      throw new Error(`Already enabled: ${entry.id}`);
    }
    await this.performAction('enable', entry);
    await this.refresh();
  }

  /**
   * Disable a plugin.
   *
   * @param entry An entry indicating which plugin to disable.
   */
  async disable(entry: IEntry): Promise<void> {
    if (!entry.enabled) {
      throw new Error(`Already disabled: ${entry.id}`);
    }
    // TODO: if there is any plugin which relies on entry, list them and ask
    await this.performAction('disable', entry);
    await this.refresh();
  }

  /**
   * Whether there are currently any actions pending.
   */
  hasPendingActions(): boolean {
    return this._pendingActions.length > 0;
  }

  /**
   * Send a request to the server to perform an action on a plugin.
   *
   * @param action A valid action to perform.
   * @param entry The plugin to perform the action on.
   */
  protected performAction(
    action: string,
    entry: IEntry
  ): Promise<IActionReply> {
    const actionRequest = this._requestAPI<IActionReply>(
      {},
      {
        method: 'POST',
        body: JSON.stringify({
          cmd: action,
          plugin_name: entry.id
        })
      }
    );

    actionRequest.then(
      _ => {
        this.actionError = null;
      },
      reason => {
        this.actionError = reason.toString();
      }
    );
    this.addPendingAction(actionRequest);
    return actionRequest;
  }

  /**
   * Add a pending action.
   *
   * @param pending A promise that resolves when the action is completed.
   */
  protected addPendingAction(pending: Promise<any>): void {
    // Add to pending actions collection
    this._pendingActions.push(pending);

    // Ensure action is removed when resolved
    const remove = () => {
      const i = this._pendingActions.indexOf(pending);
      this._pendingActions.splice(i, 1);
      this.stateChanged.emit(undefined);
    };
    pending.then(remove, remove);

    // Signal changed state
    this.stateChanged.emit(undefined);
  }

  /**
   * Refresh installed packages
   */
  async refresh(): Promise<void> {
    this.availableError = null;
    this._isLoading = true;
    this.stateChanged.emit();
    try {
      // Get the lock status from backend; if backend is not available,
      // we assume that all plugins are locked.
      //if (!PageConfig.getOption('pluginManager')) {
      //}
      //const plugins = await this._requestAPI<IEntry[]>();

      this._available = this._app.info.availablePlugins.map(plugin => {
        return {
          ...plugin,
          locked: true // TODO:
        };
      });
    } catch (reason) {
      this.availableError = reason.toString();
    } finally {
      this._isLoading = false;
      this.stateChanged.emit();
    }
  }

  /**
   * The search query.
   *
   * Setting its value triggers a new search.
   */
  get query(): string {
    return this._query;
  }
  set query(value: string) {
    if (this._query !== value) {
      this._query = value;
      this.stateChanged.emit();
      this._trackerDataChanged.emit(void 0);
    }
  }

  /**
   * A promise that resolves when the trackable data changes
   */
  get trackerDataChanged(): ISignal<PluginListModel, void> {
    return this._trackerDataChanged;
  }

  /**
   * A promise that resolves when the plugins were fetched from the server
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Call the plugin API
   *
   * @param endPoint API REST end point for the plugin
   * @param init Initial values for the request
   * @returns The response body interpreted as JSON
   */
  private async _requestAPI<T>(
    queryArgs: { [k: string]: any } = {},
    init: RequestInit = {}
  ): Promise<T> {
    // Make request to Jupyter API
    const settings = this._serverSettings;
    const requestUrl = URLExt.join(settings.baseUrl, PLUGIN_API_PATH);

    let response: Response;
    try {
      response = await ServerConnection.makeRequest(
        requestUrl + URLExt.objectToQueryString(queryArgs),
        init,
        settings
      );
    } catch (error) {
      throw new ServerConnection.NetworkError(error);
    }

    let data: any = await response.text();

    if (data.length > 0) {
      try {
        data = JSON.parse(data);
      } catch (error) {
        console.log('Not a JSON response body.', response);
      }
    }

    if (!response.ok) {
      throw new ServerConnection.ResponseError(response, data.message || data);
    }

    return data;
  }

  actionError: string | null = null;
  private _trackerDataChanged: Signal<PluginListModel, void> = new Signal(this);
  private _available: IEntry[] = [];
  private _isLoading = false;
  private _pendingActions: Promise<any>[] = [];
  private _serverSettings: ServerConnection.ISettings;
  private _ready = new PromiseDelegate<void>();
  private _query: string;
}
