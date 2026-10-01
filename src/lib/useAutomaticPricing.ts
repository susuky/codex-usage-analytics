import { useEffect } from "react";
import { refreshPricing } from "./api";

// The desktop service owns the daily cache and retry intervals across launches.
export function useAutomaticPricing() {
  useEffect(() => {
    const check = () => { void refreshPricing().catch(() => undefined); };
    check();
    const timer = window.setInterval(check, 60 * 60_000);
    window.addEventListener("online", check);
    window.addEventListener("usage-settings-changed", check);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", check);
      window.removeEventListener("usage-settings-changed", check);
    };
  }, []);
}
