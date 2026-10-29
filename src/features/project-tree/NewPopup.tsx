import { useMemo, useState, useEffect, useRef, type KeyboardEvent } from "react";
import { Icon } from "../../ui/Icon";
import { Popup } from "../../ui/Popup";
import { HighlightedText } from "../../ui/HighlightedText";
import { fuzzyMatch } from "../../ui/match";
import { useI18n } from "../../i18n";
import styles from "./NewPopup.module.css";

export interface NewPopupItem {
  id: string;
  label: string;
  icon?: string;
  shortcut?: string;
  separator?: boolean;
  onSelect: () => void;
}

export interface NewPopupProps {
  open: boolean;
  anchor: { x: number; y: number } | null;
  items: NewPopupItem[];
  onClose: () => void;
}

export function NewPopup({ open, anchor, items, onClose }: NewPopupProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;

    return items
      .filter((item) => !item.separator)
      .map((item) => {
        const indices = fuzzyMatch(item.label, q);
        return { item, match: Boolean(indices), indices };
      })
      .filter((x) => x.match)
      .map((x) => ({ ...x.item, _indices: x.indices }));
  }, [items, query]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const selectable = filteredRows.filter((r) => !r.separator);
    if (selectable.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % selectable.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + selectable.length) % selectable.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = selectable[activeIndex] || selectable[0];
      if (current) {
        onClose();
        current.onSelect();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  if (!open || !anchor) return null;

  const selectableRows = filteredRows.filter((r) => !r.separator);

  return (
    <Popup
      open={open}
      anchor={anchor}
      placement="bottom-start"
      onClose={onClose}
      className={styles.popup}
      role="dialog"
      aria-label={t("project.view.new")}
    >
      <div className={styles.search}>
        <Icon name="search" size={14} className={styles.searchIcon} />
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={query}
          placeholder={t("project.view.searchFileType")}
          aria-label={t("project.view.searchFileType")}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
        />
      </div>

      <div className={styles.list} role="listbox">
        {filteredRows.length === 0 ? (
          <div className={styles.empty}>{t("project.view.nothingFound")}</div>
        ) : (
          filteredRows.map((row, idx) => {
            if (row.separator) {
              return <div key={`sep-${idx}`} className={styles.separator} role="separator" />;
            }

            const isCurrent = selectableRows[activeIndex]?.id === row.id;

            return (
              <div
                key={row.id}
                role="option"
                aria-selected={isCurrent}
                className={`${styles.row} ${isCurrent ? styles.active : ""}`}
                onClick={() => {
                  onClose();
                  row.onSelect();
                }}
                onMouseEnter={() => {
                  const selIdx = selectableRows.findIndex((r) => r.id === row.id);
                  if (selIdx >= 0) setActiveIndex(selIdx);
                }}
              >
                <span className={styles.icon}>
                  {row.icon && <Icon name={row.icon} size={16} />}
                </span>
                <span className={styles.label}>
                  <HighlightedText text={row.label} indices={(row as any)._indices} />
                </span>
                {row.shortcut && <span className={styles.shortcut}>{row.shortcut}</span>}
              </div>
            );
          })
        )}
      </div>
    </Popup>
  );
}
