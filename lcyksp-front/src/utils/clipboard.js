/**
 * clipboard.js — 浏览器剪贴板写入兼容性工具
 *
 * 优先使用 navigator.clipboard.writeText()（现代 API），
 * 在不支持的安全上下文（非 HTTPS / 纯 IP）下自动降级为
 * document.execCommand('copy') 传统方案。
 */

/**
 * 将文本复制到系统剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyToClipboard(text) {
  // 方案一：navigator.clipboard API（现代浏览器，需安全上下文）
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或非安全上下文 → 降级
    }
  }

  // 方案二：document.execCommand('copy') 传统方案
  return fallbackCopy(text);
}

/**
 * 传统降级方案：创建隐藏 textarea → 选中 → execCommand('copy')
 */
function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;

  // 确保不可见且不触发页面滚动
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';

  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    const success = document.execCommand('copy');
    return success;
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export default { copyToClipboard };
