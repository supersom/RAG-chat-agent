"use client";

import { useEffect, useRef, useState } from "react";
import { Settings, Eye, EyeOff, Upload, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export const SETTINGS_KEY = "rag-chat-settings";

export type AppSettings = {
  llmApiKey: string;
  bawsAccessKeyId: string;
  bawsSecretAccessKey: string;
  models: string;
  knowledgeBaseId: string;
  amplifyAppId: string;
  awsRegion: string;
  nodeEnv: string;
  tenantToken?: string;
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return emptySettings();
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return emptySettings();
  }
}

function emptySettings(): AppSettings {
  return {
    llmApiKey: "",
    bawsAccessKeyId: "",
    bawsSecretAccessKey: "",
    models: "",
    knowledgeBaseId: "",
    amplifyAppId: "",
    awsRegion: "",
    nodeEnv: "",
    tenantToken: "",
  };
}

function SecretField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <label className="text-sm font-medium">{label}</label>
      <div className="relative">
        <Input
          type={visible ? "text" : "password"}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="pr-10"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

const isDevEnv = process.env.NEXT_PUBLIC_APP_ENV === "development";

export default function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AppSettings>(emptySettings());
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setForm({ ...emptySettings(), ...loadSettings() });
  }, [open]);

  const handleSave = () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(form));
    setOpen(false);
    window.location.reload();
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string);
        const merged = { ...emptySettings(), ...parsed };
        setForm(merged);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
        setImportError(null);
      } catch {
        setImportError("Invalid JSON file");
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    };
    reader.readAsText(file);
  };

  const handleExport = () => {
    const blob = new Blob([JSON.stringify(form, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "settings.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const set = (key: keyof AppSettings) => (v: string) =>
    setForm((f) => ({ ...f, [key]: v }));

  return (
    <>
      <Button variant="outline" size="icon" onClick={() => setOpen(true)}>
        <Settings className="h-[1.2rem] w-[1.2rem]" />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Models (id:Name, comma-separated)</label>
              <Input
                placeholder="gpt-4o-mini:GPT-4o Mini,gpt-4o:GPT-4o"
                value={form.models}
                onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
              />
            </div>
          </div>

          {isDevEnv && (
            <div className="flex flex-col gap-4 py-2">
              <SecretField
                label="LLM API Key"
                value={form.llmApiKey}
                placeholder="sk-..."
                onChange={set("llmApiKey")}
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">AWS Access Key ID</label>
                <Input
                  placeholder="AKIA..."
                  value={form.bawsAccessKeyId}
                  onChange={(e) => setForm((f) => ({ ...f, bawsAccessKeyId: e.target.value }))}
                />
              </div>
              <SecretField
                label="AWS Secret Access Key"
                value={form.bawsSecretAccessKey}
                placeholder="your secret"
                onChange={set("bawsSecretAccessKey")}
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Knowledge Base ID</label>
                <Input
                  placeholder="ABCD1234EF"
                  value={form.knowledgeBaseId}
                  onChange={(e) => setForm((f) => ({ ...f, knowledgeBaseId: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Amplify App ID</label>
                <Input
                  placeholder="abc123def"
                  value={form.amplifyAppId}
                  onChange={(e) => setForm((f) => ({ ...f, amplifyAppId: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">AWS Region</label>
                <Input
                  placeholder="us-east-1"
                  value={form.awsRegion}
                  onChange={(e) => setForm((f) => ({ ...f, awsRegion: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">Tenant Embed Token</label>
                <Input
                  placeholder="eyJhbGciOi..."
                  value={form.tenantToken ?? ""}
                  onChange={(e) => setForm((f) => ({ ...f, tenantToken: e.target.value }))}
                />
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 cursor-pointer w-fit">
            <input
              type="checkbox"
              checked={form.nodeEnv === "development"}
              onChange={(e) =>
                setForm((f) => ({ ...f, nodeEnv: e.target.checked ? "development" : "" }))
              }
              className="h-4 w-4 accent-primary"
            />
            <span className="text-sm font-medium">Development mode</span>
          </label>

          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Leave blank to use server environment variables.
            </p>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={handleImport}
              />
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  Import JSON
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={handleExport}
                >
                  <Download className="h-3.5 w-3.5" />
                  Save as JSON
                </Button>
              </div>
            </div>
          </div>
          {importError && (
            <p className="text-xs text-red-500">{importError}</p>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
