'use strict';
const key = 'study-todo-v1';
const list = document.querySelector('#list');
const input = document.querySelector('#task');
const notice = document.querySelector('#notice');
let tasks = [];
let filter = 'all';
try {
  const saved = JSON.parse(localStorage.getItem(key) || '[]');
  if (!Array.isArray(saved)) throw new Error('invalid');
  tasks = saved.filter(t => t && typeof t.id === 'string' && typeof t.text === 'string' && typeof t.done === 'boolean');
} catch { notice.textContent = '无法读取已保存的清单，本次可以继续使用。'; }
function save() {
  try { localStorage.setItem(key, JSON.stringify(tasks)); }
  catch { notice.textContent = '浏览器无法保存，关闭页面后本次修改可能丢失。'; }
  render();
}
function render() {
  list.replaceChildren();
  const visible = tasks.filter(t => filter === 'all' || (filter === 'done' ? t.done : !t.done));
  visible.forEach(task => {
    const row = document.createElement('li');
    row.classList.toggle('done', task.done);
    const check = document.createElement('input');
    check.type = 'checkbox'; check.checked = task.done;
    check.setAttribute('aria-label', `完成任务：${task.text}`);
    check.addEventListener('change', () => { task.done = check.checked; save(); });
    const text = document.createElement('span'); text.textContent = task.text;
    const remove = document.createElement('button'); remove.className = 'delete'; remove.textContent = '删除';
    remove.setAttribute('aria-label', `删除任务：${task.text}`);
    remove.addEventListener('click', () => { tasks = tasks.filter(t => t.id !== task.id); save(); });
    row.append(check, text, remove); list.append(row);
  });
  document.querySelector('#count').textContent = `${tasks.filter(t => !t.done).length} 项待完成`;
  const completed = tasks.filter(t => t.done).length;
  document.querySelector('#progress').max = tasks.length || 1;
  document.querySelector('#progress').value = completed;
  document.querySelector('#progress-text').textContent = `${completed} / ${tasks.length}`;
  document.querySelector('#empty').hidden = visible.length > 0;
  document.querySelector('#empty').textContent = tasks.length === 0 ? '清单还是空的，写下今天的第一件事吧。' : filter === 'done' ? '还没有完成的任务，先完成一件小事吧。' : '这里都完成了，给自己一个小小的肯定。';
  document.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; render(); }));
document.querySelector('#form').addEventListener('submit', event => {
  event.preventDefault(); const text = input.value.trim();
  if (!text) { input.value = ''; input.focus(); return; }
  tasks.push({id: crypto.randomUUID(), text, done: false});
  input.value = ''; filter = 'all'; save(); input.focus();
});
render();
// Optional browser agent interface; the page also works without it.
if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'list_study_tasks',
      description: 'Read the study tasks stored in this page without modifying them.',
      inputSchema: {type: 'object', properties: {}, additionalProperties: false},
      annotations: {readOnlyHint: true, untrustedContentHint: true},
      execute(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Expected an empty object');
        return {tasks: tasks.map(task => ({...task}))};
      }
    })).catch(() => {});
  } catch { /* Optional support must never interrupt normal use. */ }
}
