"use client";

import type {AppNetwork} from "@/lib/appStorage";
import {NETWORK_ENVIRONMENTS} from "@/lib/settingsCenter";

export function NetworkEnvironmentSelector({enabled, labels, title, hint, onChange}: {
  enabled: AppNetwork[];
  labels: Record<AppNetwork, string>;
  title: string;
  hint: string;
  onChange: (network: AppNetwork, checked: boolean) => void;
}) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-gray-100">{title}</legend>
      <p className="text-xs leading-5 text-gray-500">{hint}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {NETWORK_ENVIRONMENTS.map((network) => (
          <label key={network} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm ${enabled.includes(network) ? "border-emerald-400/35 bg-emerald-400/10 text-emerald-100" : "border-white/10 bg-black/20 text-gray-300"}`}>
            <input
              type="checkbox"
              checked={enabled.includes(network)}
              disabled={enabled.length === 1 && enabled.includes(network)}
              onChange={(event) => onChange(network, event.target.checked)}
              className="h-4 w-4 accent-emerald-500 disabled:opacity-50"
            />
            {labels[network]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
