import type { CommandRegistry as CR } from '@lumino/commands';
import type { IDisposable } from '@lumino/disposable';
import { Application } from '@lumino/application';

type CommandFuncNoArgs<T> = () => T;

interface ICommandOptionsNoArgs
  extends Omit<CR.ICommandOptions, 'describedBy'> {
  execute: CommandFuncNoArgs<any | Promise<any>>;
  isEnabled?: CommandFuncNoArgs<boolean>;
}

interface ICommandOptionsWithArgs
  extends Omit<CR.ICommandOptions, 'describedBy'> {
  describedBy:
    | Partial<CR.Description>
    | CR.CommandFunc<
        Partial<CR.Description> | Promise<Partial<CR.Description>>
      >;
}

type ICommandOptions = ICommandOptionsNoArgs | ICommandOptionsWithArgs;

// eslint-disable-next-line
interface CommandRegistry extends CR {
  addCommand(command: string, options: ICommandOptions): IDisposable;
}

declare module '@jupyterlab/application' {
  // eslint-disable-next-line
  export interface JupyterFrontEnd<
    T extends JupyterFrontEnd.IShell = JupyterFrontEnd.IShell,
    U extends string = 'desktop' | 'mobile'
  > extends Application<T> {
    commands: CommandRegistry;
  }
}
