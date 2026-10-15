import { isPostgresType } from './db-context.mjs';
import { serializeRows } from './row-copy.mjs';

function copySuccess(snapshot) {
  const subject = snapshot.rows.length === 1 ? '整行已复制为 ' : '已复制 ' + snapshot.rows.length + ' 行为 ';
  return subject + snapshot.format.toUpperCase();
}

function insertDialogHtml(postgres, rowCount) {
  const namespace = postgres ? '模式' : '数据库';
  const title = rowCount === 1 ? '复制整行为 INSERT' : '复制所选 ' + rowCount + ' 行为 INSERT';
  const description = rowCount === 1 ? '这行数据' : '所选 ' + rowCount + ' 行数据';
  return '<form class="grid-insert-form">' +
    '<h3 id="gridInsertTitle">' + title + '</h3>' +
    '<p>填写接收' + description + '的目标表，结果列名将用作字段名。</p>' +
    '<label>' + namespace + '<input name="namespace" autocomplete="off"></label>' +
    '<label>目标表<input name="table" autocomplete="off" required autofocus></label>' +
    '<div class="err-line" role="alert"></div>' +
    '<div class="btnrow"><button class="tbtn" type="button" data-cancel>取消</button>' +
    '<button class="tbtn primary" type="submit">复制 INSERT</button></div></form>';
}

function showInsertDialog(snapshot, options) {
  const dialog = options.document.createElement('dialog');
  const postgres = isPostgresType(snapshot.dbType);
  dialog.className = 'grid-insert-dialog';
  dialog.setAttribute('aria-labelledby', 'gridInsertTitle');
  dialog.innerHTML = insertDialogHtml(postgres, snapshot.rows.length);
  const form = dialog.querySelector('form');
  form.elements.namespace.value = postgres ? snapshot.context.schema || '' : snapshot.context.db || '';
  const previousFocus = options.document.activeElement;
  form.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    const errorLine = form.querySelector('.err-line');
    button.disabled = true;
    errorLine.textContent = '';
    try {
      const target = Object.freeze({
        namespace: form.elements.namespace.value,
        table: form.elements.table.value,
      });
      await options.writeClipboard(serializeRows({ ...snapshot, target }));
      options.toast(copySuccess(snapshot), 'ok');
      dialog.close();
    } catch (error) {
      errorLine.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  options.document.body.appendChild(dialog);
  dialog.showModal();
}

export function createRowCopyActions(options) {
  async function copy(snapshot) {
    if (snapshot.format === 'insert' && !snapshot.target) {
      showInsertDialog(snapshot, options);
      return;
    }
    try {
      await options.writeClipboard(serializeRows(snapshot));
      options.toast(copySuccess(snapshot), 'ok');
    } catch (error) {
      options.toast(error.message, 'err');
    }
  }
  return Object.freeze({ copy });
}
