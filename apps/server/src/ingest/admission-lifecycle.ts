export interface AdmissionReleaseHooks<Request extends object> {
  readonly onError: (request: Request) => Promise<void>;
  readonly onRequestAbort: (request: Request) => Promise<void>;
  readonly onResponse: (request: Request) => Promise<void>;
  readonly onTimeout: (request: Request) => Promise<void>;
}

export function createAdmissionReleaseHooks<Request extends object>(
  releaseRequest: (request: Request) => void,
): AdmissionReleaseHooks<Request> {
  const release = async (request: Request): Promise<void> => {
    releaseRequest(request);
  };
  return {
    onError: release,
    onRequestAbort: release,
    onResponse: release,
    onTimeout: release,
  };
}
