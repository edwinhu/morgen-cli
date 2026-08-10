/**
 * Minimal ambient types for `chrome-remote-interface`, which ships no
 * declarations. Only the surface this CLI uses is declared: attaching to a
 * target, listing targets, `Runtime.evaluate`, and `close`.
 */
declare module "chrome-remote-interface" {
  function CDP(options?: CDP.Options): Promise<CDP.Client>;

  namespace CDP {
    interface Options {
      host?: string;
      port?: number;
      target?: unknown;
    }

    interface EvaluateParams {
      expression: string;
      awaitPromise?: boolean;
      returnByValue?: boolean;
    }

    interface EvaluateResult {
      result: {
        type?: string;
        value?: unknown;
        description?: string;
      };
      exceptionDetails?: unknown;
    }

    interface Client {
      close(): Promise<void>;
      Runtime: {
        evaluate(params: EvaluateParams): Promise<EvaluateResult>;
      };
    }

    function List(options?: Options): Promise<unknown[]>;
  }

  export default CDP;
}
