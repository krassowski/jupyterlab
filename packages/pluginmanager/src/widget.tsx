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

    const header = new Header(model, this.trans);
    this.addWidget(header);

    const availableList = new AvailableList(model, this.trans);
    this.addWidget(availableList);
  }
  readonly model: PluginListModel;
  protected trans: TranslationBundle;
}

//const EntryTable = RenderTable<IEntry>;

class AvailableList extends ReactWidget {
  constructor(
    protected model: PluginListModel,
    protected trans: TranslationBundle
  ) {
    super();
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
          <Table<IEntry>
            blankIndicator={() => {
              return <div>{this.trans.__('No entries')}</div>;
            }}
            rows={this.model.available
              .filter(pkg => {
                const pattern = new RegExp(this.model.query.toLowerCase());
                return pattern.test(pkg.id) || pattern.test(pkg.extension);
              })
              .map(data => {
                return { data, key: data.id };
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
                sort: (a: IEntry, b: IEntry) => +a.autoStart - +b.autoStart
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
                renderCell: (row: IEntry) => (
                  <>{row.provides ? row.provides.name : '-'}</>
                ),
                sort: (a: IEntry, b: IEntry) =>
                  (a.provides ? a.provides.name : '').localeCompare(
                    b.provides ? b.provides.name : ''
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
                    onChange={
                      this.model.isDisclaimed ? this.onAction.bind(this) : null
                    }
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

class Header extends ReactWidget {
  constructor(
    protected model: PluginListModel,
    protected trans: TranslationBundle
  ) {
    super();
    model.stateChanged.connect(this.update, this);
    this.addClass('jp-pluginmanager-header');
  }

  render(): JSX.Element {
    return (
      <>
        <div className="jp-pluginmanager-title">
          <span>{this.trans.__('Plugin Manager')}</span>
        </div>
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
