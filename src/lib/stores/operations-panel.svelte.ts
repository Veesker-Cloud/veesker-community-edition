type Tab = "activity" | "session";

const STORAGE_KEY = "opsPanel.tab";
const VALID_TABS: readonly Tab[] = ["activity", "session"];

function loadTab(): Tab {
  if (typeof localStorage === "undefined") return "activity";
  const raw = localStorage.getItem(STORAGE_KEY);
  return VALID_TABS.includes(raw as Tab) ? (raw as Tab) : "activity";
}

let _activeTab = $state<Tab>(loadTab());
let _isOpen = $state(false);
let _autoRefreshSec = $state<number>(0);

export const operationsPanel = {
  get activeTab() {
    return _activeTab;
  },
  setTab(t: Tab): void {
    _activeTab = t;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, t);
    }
  },
  get isOpen() {
    return _isOpen;
  },
  toggle(): void {
    _isOpen = !_isOpen;
  },
  open(): void {
    _isOpen = true;
  },
  close(): void {
    _isOpen = false;
  },
  get autoRefreshSec() {
    return _autoRefreshSec;
  },
  setAutoRefresh(sec: number): void {
    _autoRefreshSec = sec;
  },
};
