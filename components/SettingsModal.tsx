"use client";

import { useEffect, useState } from "react";
import { Settings, Eye, EyeOff } from "lucide-react";
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

export default function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AppSettings>(emptySettings());

  useEffect(() => {
    if (open) setForm({ ...emptySettings(), ...loadSettings() });
  }, [open]);

  const handleSave = () => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(form));
    setOpen(false);
    window.location.reload();
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
              <label className="text-sm font-medium">Models (id:Name, comma-separated)</label>
              <Input
                placeholder="gpt-4o-mini:GPT-4o Mini,gpt-4o:GPT-4o"
                value={form.models}
                onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Knowledge Base ID</label>
              <Input
                placeholder="ABCD1234EF"
                value={form.knowledgeBaseId}
                onChange={(e) => setForm((f) => ({ ...f, knowledgeBaseId: e.target.value }))}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Leave blank to use server environment variables. Saved to browser localStorage.
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
