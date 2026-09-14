export function bindManagementFilterForm({ config, form, keyword, onApply, onReset }) {
  if (!config || typeof config !== 'object') throw new TypeError('management list page config is required');
  if (!(form instanceof HTMLFormElement)) throw new TypeError('management filter form is required');
  if (!(keyword instanceof HTMLInputElement)) throw new TypeError('management keyword input is required');
  if (typeof onApply !== 'function' || typeof onReset !== 'function') throw new TypeError('management filter callbacks are required');
  if (keyword !== form.querySelector(config.keyword.selector)) throw new TypeError(`management keyword selector ${config.keyword.selector} does not match the supplied input`);
  keyword.placeholder = config.keyword.placeholder;
  keyword.dataset.queryParameter = config.keyword.queryParameter;
  form.dataset.endpoint = config.endpoint;
  form.dataset.pageSize = String(config.pageSize);
  for (const filter of config.filters) {
    const control = form.querySelector(filter.selector);
    if (!control) throw new TypeError(`management filter selector ${filter.selector} does not match a control`);
    control.dataset.queryParameter = filter.queryParameter;
    control.closest('label')?.setAttribute('data-field-label', filter.label);
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void onApply();
  });
  form.querySelector('[data-action="reset-filters"]')?.addEventListener('click', () => {
    form.reset();
    void onReset();
    keyword.focus();
  });
}
