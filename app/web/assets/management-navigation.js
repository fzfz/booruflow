import { MANAGEMENT_NAVIGATION_GROUPS, MANAGEMENT_NAVIGATION_ITEMS } from './management-navigation-config.mjs';

const navigation = document.querySelector('#management-navigation');
if (!navigation) throw new Error('management navigation container is required');

const currentPageId = navigation.dataset.managementPageId;
const brand = document.createElement('a');
brand.className = 'management-navigation-brand';
brand.href = '/';
brand.innerHTML = '<strong>BooruFlow</strong><span>本地资源管理</span>';

const links = document.createElement('div');
links.className = 'management-navigation-links';
for (const group of MANAGEMENT_NAVIGATION_GROUPS) {
  const items = MANAGEMENT_NAVIGATION_ITEMS.filter((item) => item.enabled && item.group === group.id);
  if (items.length === 0) continue;
  const section = document.createElement('section');
  section.className = 'management-navigation-group';
  const heading = document.createElement('p');
  heading.className = 'management-navigation-group-label';
  heading.innerHTML = `<span>${group.code}</span>${group.label}`;
  section.append(heading);
  for (const item of items) {
    const link = document.createElement('a');
    link.className = 'management-navigation-link';
    link.href = item.url;
    link.textContent = item.label;
    link.dataset.managementPageId = item.id;
    link.dataset.managementView = item.view;
    if (item.id === currentPageId) link.setAttribute('aria-current', 'page');
    section.append(link);
  }
  links.append(section);
}
navigation.replaceChildren(brand, links);

const currentItem = MANAGEMENT_NAVIGATION_ITEMS.find(({ id }) => id === currentPageId);
const currentGroup = MANAGEMENT_NAVIGATION_GROUPS.find(({ id }) => id === currentItem?.group);
let workspaceBar = document.querySelector('.workspace-bar');
if (!workspaceBar) {
  workspaceBar = document.createElement('header');
  workspaceBar.className = 'workspace-bar';
  navigation.insertAdjacentElement('afterend', workspaceBar);
}
let breadcrumb = workspaceBar.querySelector('.breadcrumb');
if (!breadcrumb) {
  breadcrumb = document.createElement('div');
  breadcrumb.className = 'breadcrumb';
  workspaceBar.append(breadcrumb);
}
breadcrumb.innerHTML = `<span>${currentGroup?.label ?? ''}</span> / <strong>${currentItem?.label ?? ''}</strong>`;

const toggle = document.createElement('button');
toggle.type = 'button';
toggle.className = 'management-menu-toggle';
toggle.setAttribute('aria-label', '打开管理菜单');
toggle.setAttribute('aria-expanded', 'false');
toggle.textContent = '管理菜单';
workspaceBar.prepend(toggle);
const scrim = document.createElement('button');
scrim.type = 'button';
scrim.className = 'sidebar-scrim';
scrim.setAttribute('aria-label', '关闭管理菜单');
navigation.insertAdjacentElement('afterend', scrim);

function setMenuOpen(open) {
  navigation.classList.toggle('is-open', open);
  scrim.classList.toggle('is-open', open);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.setAttribute('aria-label', open ? '关闭管理菜单' : '打开管理菜单');
}

toggle.addEventListener('click', () => {
  setMenuOpen(!navigation.classList.contains('is-open'));
});
scrim.addEventListener('click', () => {
  setMenuOpen(false);
  toggle.focus();
});
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    setMenuOpen(false);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !navigation.classList.contains('is-open')) return;
  event.preventDefault();
  setMenuOpen(false);
  toggle.focus();
});

const initialFocus = navigation.dataset.managementInitialFocus
  ? document.querySelector(navigation.dataset.managementInitialFocus)
  : null;
if (navigation.dataset.managementInitialFocus && !(initialFocus instanceof HTMLElement)) throw new Error('management initial focus target is required');
if (initialFocus instanceof HTMLElement) initialFocus.focus({ preventScroll: true });
