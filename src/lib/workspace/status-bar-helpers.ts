export function shouldShowUserHost(username: string | undefined, serviceName: string | undefined): boolean {
  return Boolean(username && serviceName);
}

export type TxButtonState = {
  enabled: boolean;
  ariaDisabled: "true" | "false";
};

export function txButtonState(hasPendingTx: boolean): TxButtonState {
  return {
    enabled: hasPendingTx,
    ariaDisabled: hasPendingTx ? "false" : "true",
  };
}
