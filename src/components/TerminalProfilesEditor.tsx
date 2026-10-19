import { Plus, Trash2 } from "lucide-react";
import Select from "./Select";
import type { ShellInfo } from "../lib/term";
import type { TerminalProfile } from "../lib/settings";
import { formatArgs, formatEnvLines, parseArgs, parseEnvLines } from "../lib/termProfiles";
import { useI18n } from "../i18n";

interface TerminalProfilesEditorProps {
  profiles: TerminalProfile[];
  shells: ShellInfo[];
  onChange: (profiles: TerminalProfile[]) => void;
}

/** 新配置档的 id：时间戳加随机尾巴，存盘后不再变，恢复页签靠它认。 */
function newProfileId(): string {
  return `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 设置页「终端」里的配置档列表。一档一张卡。
 * 文本框失焦才写回：边敲边存会让每个字母都整份重写一次设置文件。
 */
export default function TerminalProfilesEditor({ profiles, shells, onChange }: TerminalProfilesEditorProps) {
  const { t } = useI18n();

  const update = (id: string, next: Partial<TerminalProfile>) =>
    onChange(profiles.map((profile) => (profile.id === id ? { ...profile, ...next } : profile)));

  const add = () =>
    onChange([
      ...profiles,
      {
        id: newProfileId(),
        name: t("settings.terminalProfileNew"),
        shell: "",
        args: [],
        env: [],
        dir: "",
        command: "",
      },
    ]);

  const shellOptions = [
    { value: "", label: t("settings.terminalProfileShellDefault") },
    ...shells.map((shell) => ({ value: shell.id, label: shell.name, detail: [shell.path, ...shell.args].join(" ") })),
  ];

  /** 失焦写回的文本框。key 跟着值走：外面改了（比如重置）输入框跟着换。 */
  const field = (
    profile: TerminalProfile,
    label: string,
    value: string,
    placeholder: string,
    commit: (text: string) => Partial<TerminalProfile>,
    multiline = false,
  ) => (
    <div className={`settings-row${multiline ? " is-stack" : ""}`}>
      <span className="settings-label">{label}</span>
      {multiline ? (
        <textarea
          key={`${profile.id}:${value}`}
          className="settings-input is-code"
          defaultValue={value}
          placeholder={placeholder}
          spellCheck={false}
          rows={3}
          onBlur={(event) => {
            if (event.target.value !== value) update(profile.id, commit(event.target.value));
          }}
        />
      ) : (
        <input
          key={`${profile.id}:${value}`}
          className="settings-input is-wide"
          defaultValue={value}
          placeholder={placeholder}
          spellCheck={false}
          onBlur={(event) => {
            if (event.target.value !== value) update(profile.id, commit(event.target.value));
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    </div>
  );

  return (
    <div className="settings-row is-stack">
      <span className="settings-label">{t("settings.terminalProfiles")}</span>
      <div className="term-profiles">
        <p className="settings-note">{t("settings.terminalProfilesHint")}</p>
        {profiles.map((profile) => (
          <section key={profile.id} className="term-profile">
            <header className="term-profile-head">
              <input
                key={`${profile.id}:name:${profile.name}`}
                className="settings-input term-profile-name"
                defaultValue={profile.name}
                aria-label={t("settings.terminalProfileName")}
                onBlur={(event) => {
                  const name = event.target.value.trim();
                  if (name && name !== profile.name) update(profile.id, { name });
                  else event.target.value = profile.name;
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <button
                type="button"
                className="icon-button is-inline"
                title={t("settings.terminalProfileRemove")}
                onClick={() => onChange(profiles.filter((item) => item.id !== profile.id))}
              >
                <Trash2 size={14} />
              </button>
            </header>
            <div className="settings-row">
              <span className="settings-label">{t("settings.terminalProfileShell")}</span>
              <Select
                className="is-wide"
                label={t("settings.terminalProfileShell")}
                placeholder="—"
                value={profile.shell}
                options={shellOptions}
                onChange={(shell) => update(profile.id, { shell })}
              />
            </div>
            {field(
              profile,
              t("settings.terminalProfileArgs"),
              formatArgs(profile.args),
              t("settings.terminalProfileArgsPlaceholder"),
              (text) => ({ args: parseArgs(text) }),
            )}
            {field(
              profile,
              t("settings.terminalProfileDir"),
              profile.dir,
              t("settings.terminalProfileDirPlaceholder"),
              (text) => ({ dir: text.trim() }),
            )}
            {field(
              profile,
              t("settings.terminalProfileEnv"),
              formatEnvLines(profile.env),
              t("settings.terminalProfileEnvPlaceholder"),
              (text) => ({ env: parseEnvLines(text) }),
              true,
            )}
            {field(
              profile,
              t("settings.terminalProfileCommand"),
              profile.command,
              t("settings.terminalProfileCommandPlaceholder"),
              (text) => ({ command: text.trim() }),
            )}
          </section>
        ))}
        <button type="button" className="text-button term-profile-add" onClick={add}>
          <Plus size={13} aria-hidden="true" />
          {t("settings.terminalProfileAdd")}
        </button>
      </div>
    </div>
  );
}
