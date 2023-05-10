import { ITranslator, TranslationBundle } from '@jupyterlab/translation';
import { FilterBox, ReactWidget } from '@jupyterlab/ui-components';
import { Panel } from '@lumino/widgets';
import * as React from 'react';
import { Action, IEntry, PluginListModel } from './model';
import { Table } from './table';

export namespace Plugins {
  export interface IOptions {
    model: PluginListModel;
    translator: ITranslator;
  }
}

export class Plugins extends Panel {
  constructor(options: Plugins.IOptions) {
    const { model, translator } = options;
    super();
    this.model = model;
    this.addClass('jp-pluginmanager');

    this.trans = translator.load('jupyterlab');

    this.addWidget(new Disclaimer(model, this.trans));

    const header = new Header(model, this.trans);
    this.addWidget(header);

    const availableList = new AvailableList(model, this.trans);
    this.addWidget(availableList);
  }
  readonly model: PluginListModel;
  protected trans: TranslationBundle;
}

interface IProcessedEntry extends IEntry {
  /** The token name (the part after colon) */
  tokenName?: string;
}

class AvailableList extends ReactWidget {
  constructor(
    protected model: PluginListModel,
    protected trans: TranslationBundle
  ) {
    super();
    this.addClass('jp-pluginmanager-AvailableList');
    model.stateChanged.connect(this.update, this);
  }

  render(): JSX.Element {
    return (
      <>
        {this.model.availableError !== null ? (
          <ErrorMessage>
            {`Error querying installed extensions${
              this.model.availableError ? `: ${this.model.availableError}` : '.'
            }`}
          </ErrorMessage>
        ) : this.model.isLoading ? (
          <div className="jp-pluginmanager-loader">
            {this.trans.__('Updating plugin list…')}
          </div>
        ) : (
          <Table<IProcessedEntry>
            blankIndicator={() => {
              return <div>{this.trans.__('No entries')}</div>;
            }}
            sortKey={'plugin-id'}
            rows={this.model.available
              .filter(pkg => {
                const pattern = new RegExp(this.model.query.toLowerCase());
                return pattern.test(pkg.id) || pattern.test(pkg.extension);
              })
              .map(data => {
                return {
                  data: {
                    ...data,
                    tokenName: data.provides
                      ? data.provides.name.split(':')[1]
                      : undefined
                  },
                  key: data.id
                };
              })}
            columns={[
              {
                id: 'plugin-id',
                label: this.trans.__('Plugin'),
                renderCell: (row: IEntry) => (
                  <>
                    <code>{row.id}</code>
                    <br />
                    {row.description}
                  </>
                ),
                sort: (a: IEntry, b: IEntry) => a.id.localeCompare(b.id)
              },
              {
                id: 'description',
                label: this.trans.__('Description'),
                renderCell: (row: IEntry) => <>{row.description}</>,
                sort: (a: IEntry, b: IEntry) =>
                  a.description.localeCompare(b.description),
                isHidden: true
              },
              {
                id: 'autostart',
                label: this.trans.__('Autostart?'),
                renderCell: (row: IEntry) => (
                  <>
                    {row.autoStart ? this.trans.__('Yes') : this.trans.__('No')}
                  </>
                ),
                sort: (a: IEntry, b: IEntry) =>
                  a.autoStart === b.autoStart ? 0 : a.autoStart ? -1 : 1
              },
              {
                id: 'requires',
                label: this.trans.__('Depends on'),
                renderCell: (row: IEntry) => (
                  <>{row.requires.map(v => v.name).join('\n')}</>
                ),
                sort: (a: IEntry, b: IEntry) =>
                  (a.requires || []).length - (b.requires || []).length,
                isHidden: true
              },
              {
                id: 'provides',
                label: this.trans.__('Provides'),
                renderCell: (row: IProcessedEntry) => (
                  <>
                    {row.provides ? (
                      <code title={row.provides.name}>{row.tokenName}</code>
                    ) : (
                      '-'
                    )}
                  </>
                ),
                sort: (a: IProcessedEntry, b: IProcessedEntry) =>
                  (a.tokenName ? a.tokenName : '').localeCompare(
                    b.tokenName ? b.tokenName : ''
                  )
              },
              {
                id: 'enabled',
                label: this.trans.__('Enabled'),
                renderCell: (row: IEntry) => (
                  <input
                    type="checkbox"
                    defaultChecked={row.enabled}
                    disabled={this.model.canModify && this.model.isDisclaimed}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      if (!this.model.isDisclaimed) {
                        return;
                      }
                      if (event.target.value) {
                        this.onAction('disable', row);
                      } else {
                        this.onAction('enable', row);
                      }
                    }}
                  />
                ),
                sort: (a: IEntry, b: IEntry) =>
                  a.description.localeCompare(b.description)
              }
            ]}
          />
        )}
      </>
    );
  }

  /**
   * Callback handler for when the user wants to perform an action on an extension.
   *
   * @param action The action to perform.
   * @param entry The entry to perform the action on.
   */
  onAction(action: Action, entry: IEntry): Promise<void> {
    switch (action) {
      case 'enable':
        return this.model.enable(entry);
      case 'disable':
        return this.model.disable(entry);
      default:
        throw new Error(`Invalid action: ${action}`);
    }
  }
}

class Disclaimer extends ReactWidget {
  constructor(
    protected model: PluginListModel,
    protected trans: TranslationBundle
  ) {
    super();
    model.stateChanged.connect(this.update, this);
    this.addClass('jp-pluginmanager-Disclaimer');
  }
  render(): JSX.Element {
    return (
      <div>
        <div>
          {this.trans.__(
            'Plugins are the building blocks of Jupyter frontend architecture. The core application is composed of multiple plugins and each extension can be composed of one or more plugins.'
          )}
          <ul>
            <li>
              {this.trans.__(
                'Customise your experience by disabling the plugins you do not need (and get better performance).'
              )}
            </li>
            <li>
              {this.trans.__(
                'Disabling core application plugins may render features and parts of the user interface unavailable.'
              )}
            </li>
            <li>
              {this.trans.__(
                'To disable or uninstall an entire extension please use Extension Manager instead.'
              )}
            </li>
            <li>
              {this.trans.__(
                'To re-enable previously disabled plugin from command line use:'
              )}{' '}
              <code>jupyter labextension enable {'{plugin-name}'}</code>
            </li>
          </ul>
        </div>
        <label>
          <input type="checkbox" checked />
          {this.trans.__(
            'I understand implications of disabling core application plugins.'
          )}
        </label>
      </div>
    );
  }
}

class Header extends ReactWidget {
  constructor(
    protected model: PluginListModel,
    protected trans: TranslationBundle
  ) {
    super();
    model.stateChanged.connect(this.update, this);
    this.addClass('jp-pluginmanager-Header');
  }

  render(): JSX.Element {
    return (
      <>
        <FilterBox
          placeholder={this.trans.__('Filter')}
          disabled={!this.model.isDisclaimed}
          updateFilter={(fn, query) => {
            this.model.query = query ?? '';
          }}
          useFuzzyFilter={false}
        />
        <div
          className={`jp-pluginmanager-pending ${
            this.model.hasPendingActions() ? 'jp-mod-hasPending' : ''
          }`}
        />
        {this.model.actionError && (
          <ErrorMessage>
            <p>{this.trans.__('Error when performing an action.')}</p>
            <p>{this.trans.__('Reason given:')}</p>
            <pre>{this.model.actionError}</pre>
          </ErrorMessage>
        )}
      </>
    );
  }
}

function ErrorMessage(props: ErrorMessage.IProperties) {
  return <div className="jp-pluginmanager-error">{props.children}</div>;
}

namespace ErrorMessage {
  export interface IProperties {
    children: React.ReactNode;
  }
}
