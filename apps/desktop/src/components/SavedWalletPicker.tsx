import { Check, Copy, LoaderCircle } from "lucide-react";
import {
  authFormsWithWallets,
  type FormState,
  type SavedWallet,
  type WalletAuthTab,
  walletLabel,
} from "@/lib/walletAuth";

interface SavedWalletPickerProps {
  copied: string | null;
  formData: FormState;
  formId: string;
  loading: boolean;
  t: (key: string, values?: Record<string, string>) => string;
  walletAuth: WalletAuthTab;
  wallets: SavedWallet[];
  showTemporaryKeystore?: boolean;
  onCopy: (text: string, id: string) => void;
  onFieldChange: (field: string, value: string | number | undefined) => void;
  onKeystoreUpload?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
}

export function SavedWalletPicker({
  copied,
  formData,
  formId,
  loading,
  t,
  walletAuth,
  wallets,
  showTemporaryKeystore = false,
  onCopy,
  onFieldChange,
  onKeystoreUpload,
  onRefresh,
}: SavedWalletPickerProps) {
  if (!authFormsWithWallets.has(formId) || walletAuth !== "keystore") {
    return null;
  }

  const selectedWallet = wallets.find((wallet) => wallet.id === formData.wallet_id);

  if (selectedWallet && !showTemporaryKeystore) {
    return null;
  }

  return (
    <div className="space-y-3 p-4 bg-white/5 border border-white/10 rounded-lg">
      {selectedWallet ? (
        <div className="space-y-2">
          <label className="block text-sm font-medium">{t("formUi.savedWallet")}</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 px-3 py-2 bg-black/30 rounded text-xs break-all">
              {walletLabel(selectedWallet)}
            </code>
            <button
              type="button"
              onClick={() => onCopy(selectedWallet.public_key, "selected-wallet")}
              className="px-3 py-2 bg-white/10 rounded hover:bg-white/20 transition-colors"
            >
              {copied === "selected-wallet" ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            <label className="block text-sm font-medium">{t("formUi.savedWallet")}</label>
            <button
              type="button"
              onClick={onRefresh}
              disabled={loading}
              aria-busy={loading}
              className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/10 rounded text-xs hover:bg-white/20 transition-colors disabled:opacity-50"
            >
              {loading && <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {loading ? t("common.loading") : t("formUi.refreshWallets")}
            </button>
          </div>
          <select
            disabled={loading}
            value={formData.wallet_id || ""}
            onChange={(e) => {
              onFieldChange("wallet_id", e.target.value || undefined);
              onFieldChange("keystoreJson", undefined);
            }}
            className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white"
          >
            <option value="">{t("formUi.selectWallet")}</option>
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {walletLabel(wallet)}
              </option>
            ))}
          </select>
        </>
      )}
      {showTemporaryKeystore && onKeystoreUpload && !formData.wallet_id && (
        <div className="space-y-2">
          <div className="text-center text-xs text-gray-500">{t("features.import-keystore.or")}</div>
          <div>
            <label className="block text-sm font-medium mb-2">{t("formUi.uploadKeystore")}</label>
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => {
                onFieldChange("wallet_id", undefined);
                onKeystoreUpload(event);
              }}
              className="w-full px-4 py-2 bg-white/5 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-white/20 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-white/10 file:text-white hover:file:bg-white/20"
            />
            {formData.keystoreJson && (
              <p className="mt-2 text-xs text-green-400">{t("formUi.fileUploadedOk")}</p>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-gray-400">{t("formUi.savedWalletHint")}</p>
    </div>
  );
}
