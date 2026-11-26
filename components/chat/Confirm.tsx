"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Btn, Icon, IconBtn, Spinner } from "@/components/ui/kit";

// 通用弹层：遮罩点击与 Escape 关闭，焦点落在卡片上
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    // 内部有 autoFocus 输入框时不要抢焦点
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <IconBtn label="关闭" icon={<Icon name="close" size={14} />} onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// 二次确认：危险动作统一走这里，确认按钮按 tone 切换主色/危险色
export function Confirm({
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  tone = "primary",
  busy = false,
  error,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Btn size="sm" variant="ghost" onClick={onClose} disabled={busy} aria-label={cancelLabel} title={cancelLabel}>
            {cancelLabel}
          </Btn>
          <Btn
            size="sm"
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            icon={busy ? <Spinner size={12} /> : undefined}
            aria-label={confirmLabel}
            title={confirmLabel}
          >
            {confirmLabel}
          </Btn>
        </>
      }
    >
      {message && <div className="modal-message">{message}</div>}
      {children}
      {error && (
        <div className="modal-error" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}
