export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

let _toasts = $state<Toast[]>([]);
const _timers = new Map<string, ReturnType<typeof setTimeout>>();

export const toasts = {
  get all() {
    return _toasts;
  },
  push(kind: ToastKind, message: string) {
    const id = crypto.randomUUID();
    _toasts.push({ id, kind, message });
    const timer = setTimeout(() => this.dismiss(id), 5000);
    _timers.set(id, timer);
  },
  dismiss(id: string) {
    const timer = _timers.get(id);
    if (timer) {
      clearTimeout(timer);
      _timers.delete(id);
    }
    _toasts = _toasts.filter((t) => t.id !== id);
  },
  error(msg: string) {
    this.push("error", msg);
  },
  success(msg: string) {
    this.push("success", msg);
  },
  info(msg: string) {
    this.push("info", msg);
  },
  warning(msg: string) {
    this.push("warning", msg);
  },
};
