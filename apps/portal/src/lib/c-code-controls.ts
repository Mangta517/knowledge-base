/**
 * Shared client-side expand/collapse and copy controls for CSourceCard code blocks.
 * Bundled as a standard ES module by Astro/Vite (no inline scripts; CSP compliant).
 */

export function setCodeBoxOpen(box: HTMLElement, open: boolean): void {
  const body = box.querySelector<HTMLElement>('[data-c-code-body]');
  if (!body) return;
  box.classList.toggle('is-collapsed', !open);
  body.hidden = !open;

  box.querySelectorAll<HTMLButtonElement>('[data-c-toggle]').forEach((btn) => {
    btn.setAttribute('aria-expanded', String(open));
    if (btn.classList.contains('kb-cs-toggle-btn')) {
      btn.textContent = open ? '收起源码' : '展开源码';
    }
  });
}

export function getVisibleCodeBoxes(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('[data-c-code-box]')).filter((box) => {
    const card = box.closest<HTMLElement>('[data-ev-item]');
    if (card && card.hidden) return false;
    const panel = box.closest<HTMLElement>('[data-ev-panel]');
    if (panel && panel.hidden) return false;
    return true;
  });
}

export function syncBulkToggle(scope: HTMLElement): void {
  const bulkBtn = scope.querySelector<HTMLButtonElement>('[data-c-toggle-all]');
  if (!bulkBtn) return;
  const boxes = getVisibleCodeBoxes(scope);
  if (boxes.length === 0) {
    bulkBtn.hidden = true;
    return;
  }
  bulkBtn.hidden = false;
  const allOpen = boxes.every((box) => !box.classList.contains('is-collapsed'));
  bulkBtn.dataset.bulkState = allOpen ? 'open' : 'closed';
  bulkBtn.setAttribute('aria-pressed', String(allOpen));
  bulkBtn.textContent = allOpen ? '收起全部代码' : '展开全部代码';
}

export function handleCCodeClick(scope: HTMLElement, target: HTMLElement): boolean {
  const bulkBtn = target.closest<HTMLButtonElement>('[data-c-toggle-all]');
  if (bulkBtn) {
    const boxes = getVisibleCodeBoxes(scope);
    const shouldOpen = bulkBtn.dataset.bulkState !== 'open';
    boxes.forEach((box) => setCodeBoxOpen(box, shouldOpen));
    syncBulkToggle(scope);
    return true;
  }

  const toggleBtn = target.closest<HTMLButtonElement>('[data-c-toggle]');
  if (toggleBtn) {
    const box = toggleBtn.closest<HTMLElement>('[data-c-code-box]');
    if (!box) return true;
    const shouldOpen = box.classList.contains('is-collapsed');
    setCodeBoxOpen(box, shouldOpen);
    syncBulkToggle(scope);
    return true;
  }

  const copyBtn = target.closest<HTMLButtonElement>('[data-c-copy]');
  if (copyBtn) {
    const box = copyBtn.closest<HTMLElement>('[data-c-code-box]');
    if (!box) return true;
    const rawCode = Array.from(box.querySelectorAll<HTMLElement>('.kb-c-line-code'))
      .map((el) => (el.textContent || '').replace(/\u200B/g, ''))
      .join('\n');
    if (!rawCode) return true;
    const original = copyBtn.dataset.origLabel || copyBtn.textContent || '复制 C 代码';
    copyBtn.dataset.origLabel = original;
    navigator.clipboard
      .writeText(rawCode)
      .then(() => {
        copyBtn.textContent = '已复制 ✓';
        copyBtn.classList.add('is-copied');
        window.setTimeout(() => {
          copyBtn.textContent = original;
          copyBtn.classList.remove('is-copied');
        }, 1800);
      })
      .catch(() => {
        copyBtn.textContent = '复制失败';
        window.setTimeout(() => {
          copyBtn.textContent = original;
        }, 1600);
      });
    return true;
  }

  return false;
}
