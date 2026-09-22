/**
 * A stand-in for the editor's `vscode` module, for tests and nothing else.
 *
 * The extension host provides `vscode` at runtime and nothing else does, so a
 * module that imports it cannot be loaded under Node — which is why
 * `provider.ts`, `credentials.ts` and `extension.ts` were untested and review
 * of #356 said so, eleven times. The `clients` Vitest project aliases `vscode`
 * to this file, and the three modules load.
 *
 * It carries **only what this extension calls**, and it is not the editor: a
 * test against it says what the extension sends, stores, throws and shows,
 * and nothing about how the picker renders it. The classes are real classes
 * because the extension recognises the editor's parts with `instanceof`, and
 * a test that constructs a part from here is constructing the same class the
 * provider checks against.
 *
 * `state` is the seam. A test sets what the next input box or quick pick
 * answers, and reads back what was shown, registered and logged. Tests import
 * it from this file directly; the alias resolves `vscode` to the same module
 * instance, so the two views agree.
 */

interface Disposable {
  dispose(): void;
}

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    readonly callId: string,
    readonly name: string,
    readonly input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    readonly callId: string,
    readonly content: unknown[],
  ) {}
}

export class LanguageModelDataPart {
  constructor(
    readonly data: Uint8Array,
    readonly mimeType: string,
  ) {}
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export class LanguageModelError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "LanguageModelError";
  }

  static NoPermissions(message = ""): LanguageModelError {
    return new LanguageModelError(message, "NoPermissions");
  }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>();
  readonly token = {
    isCancellationRequested: false,
    // As the editor's token behaves: a listener registered after cancellation
    // is called anyway, on the next turn of the loop. The provider registers
    // its listener after an `await`, and a stop pressed before that await
    // resolves would otherwise never reach the request's abort signal.
    onCancellationRequested: (listener: Listener<void>): Disposable => {
      if (this.token.isCancellationRequested) {
        const handle = setTimeout(listener, 0);
        return { dispose: () => clearTimeout(handle) };
      }
      return this.emitter.event(listener);
    },
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** The editor's keychain, in memory. */
export class MemorySecrets {
  private readonly entries = new Map<string, string>();
  private readonly changed = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.changed.event;

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.entries.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
    this.changed.fire({ key });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    this.changed.fire({ key });
    return Promise.resolve();
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.entries.keys()]);
  }

  /** For assertions: what the keychain holds under `key`. */
  peek(key: string): string | undefined {
    return this.entries.get(key);
  }
}

/** Everything a test sets up or reads back. Reset it in `beforeEach`. */
export const state = {
  /** Settings, keyed by the dotted name. `undefined` is unset. */
  settings: new Map<string, unknown>(),
  /** Where each `update` went, so a test can assert Global rather than Workspace. */
  updates: [] as { key: string; value: unknown; target: ConfigurationTarget | undefined }[],
  /** What the next `showInputBox` resolves to. `undefined` is the user cancelling. */
  inputBox: undefined as string | undefined,
  /** The `id` of the item the next `showQuickPick` picks. `undefined` cancels. A list answers successive picks in order. */
  quickPick: undefined as string | string[] | undefined,
  /** Every notification shown, in order. A modal carries its detail and buttons. */
  shown: [] as { level: "info" | "warning" | "error"; message: string; modal?: boolean; detail?: string; actions?: string[] }[],
  /** The button the next error dialog resolves to. `undefined` dismisses it. */
  dialogChoice: undefined as string | undefined,
  /** Every `executeCommand`, by id. */
  executed: [] as string[],
  /** How many times the output channel was revealed. */
  logShown: 0,
  /** Every line logged to the output channel. */
  logged: [] as { level: string; message: string }[],
  /** Providers registered, by vendor. */
  providers: new Map<string, unknown>(),
  /** Commands registered, by id. */
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  configurationListeners: [] as Listener<{ affectsConfiguration(section: string): boolean }>[],

  reset(): void {
    this.settings.clear();
    this.updates = [];
    this.inputBox = undefined;
    this.quickPick = undefined;
    this.shown = [];
    this.dialogChoice = undefined;
    this.executed = [];
    this.logShown = 0;
    this.logged = [];
    this.providers.clear();
    this.commands.clear();
    this.configurationListeners = [];
  },

  /** Fire a configuration change for `section`, as the editor would. */
  changeConfiguration(section: string): void {
    for (const listener of this.configurationListeners) {
      listener({ affectsConfiguration: (candidate) => candidate === section });
    }
  },
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(key: string): T | undefined => state.settings.get(key) as T | undefined,
    update: (key: string, value: unknown, target?: ConfigurationTarget): Promise<void> => {
      state.settings.set(key, value);
      state.updates.push({ key, value, target });
      // As the editor does: a write is announced, and the extension's own
      // listener refreshes the model list from it.
      state.changeConfiguration(key);
      return Promise.resolve();
    },
  }),
  onDidChangeConfiguration: (listener: Listener<{ affectsConfiguration(section: string): boolean }>): Disposable => {
    state.configurationListeners.push(listener);
    return { dispose: () => undefined };
  },
};

export const window = {
  showInputBox: (): Promise<string | undefined> => Promise.resolve(state.inputBox),
  showQuickPick: <T extends { id: string }>(items: T[]): Promise<T | undefined> => {
    const id = Array.isArray(state.quickPick) ? state.quickPick.shift() : state.quickPick;
    return Promise.resolve(items.find((item) => item.id === id));
  },
  showInformationMessage: (message: string): Promise<undefined> => {
    state.shown.push({ level: "info", message });
    return Promise.resolve(undefined);
  },
  showWarningMessage: (message: string): Promise<undefined> => {
    state.shown.push({ level: "warning", message });
    return Promise.resolve(undefined);
  },
  showErrorMessage: (message: string, ...rest: unknown[]): Promise<string | undefined> => {
    const options = typeof rest[0] === "object" && rest[0] !== null ? (rest.shift() as { modal?: boolean; detail?: string }) : undefined;
    const actions = rest as string[];
    if (options === undefined && actions.length === 0) {
      state.shown.push({ level: "error", message });
      return Promise.resolve(undefined);
    }
    state.shown.push({ level: "error", message, modal: options?.modal ?? false, detail: options?.detail ?? "", actions });
    return Promise.resolve(actions.includes(state.dialogChoice ?? "") ? state.dialogChoice : undefined);
  },
  createOutputChannel: (): Record<string, (message?: string) => void> => {
    const line = (level: string) => (message?: string) => {
      state.logged.push({ level, message: message ?? "" });
    };
    return { info: line("info"), warn: line("warn"), error: line("error"), debug: line("debug"), trace: line("trace"), appendLine: line("append"), show: () => { state.logShown++; }, dispose: () => undefined };
  },
};

export const lm = {
  registerLanguageModelChatProvider: (vendor: string, provider: unknown): Disposable => {
    state.providers.set(vendor, provider);
    return { dispose: () => state.providers.delete(vendor) };
  },
};

export const commands = {
  registerCommand: (id: string, handler: (...args: unknown[]) => unknown): Disposable => {
    state.commands.set(id, handler);
    return { dispose: () => state.commands.delete(id) };
  },
  executeCommand: (id: string): Promise<undefined> => {
    state.executed.push(id);
    return Promise.resolve(undefined);
  },
};
