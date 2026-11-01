
let engineJobBusy = false;

export function isEngineJobBusy(): boolean {
  return engineJobBusy;
}

export function setEngineJobBusy(busy: boolean): void {
  engineJobBusy = busy;
}
