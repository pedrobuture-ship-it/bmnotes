import { useEffect } from "react";
import { ipc } from "@/lib/ipc";
import { tr } from "@/lib/i18n";
import { useSettings } from "@/stores/settings";
import { useUi } from "@/stores/ui";
import { useWorkspace } from "@/stores/workspace";

const KEY = "bmnotes.update.last";
const DAY = 86_400_000;

/** Opt-in: once a day, tell the user when a newer release exists. */
export function useUpdateCheck() {
  const loaded = useSettings((s) => s.loaded);
  const enabled = useSettings((s) => s.settings.updates.check);
  const root = useWorkspace((s) => s.info?.root);
  useEffect(() => {
    if (!loaded || !enabled || !root) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem(KEY) ?? 0);
    } catch {
      /* no storage: check once per session */
    }
    if (Date.now() - last < DAY) return;
    void ipc.checkUpdate().then((u) => {
      try {
        localStorage.setItem(KEY, String(Date.now()));
      } catch {
        /* ignore */
      }
      if (u.newer) useUi.getState().toast(tr("Version {v} is available. See Settings → Updates.", { v: u.latest }), "info");
    }).catch(() => {});
  }, [loaded, enabled, root]);
}
