export function setupTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];

  function select(next, focus = false) {
    for (const tab of tabs) {
      const selected = tab === next;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) next.focus();
    document.body.dataset.tab = next.id;
    window.scrollTo(0, 0);
  }

  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length,
        Home: 0, End: tabs.length - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(tabs[next], true);
    });
  }
}

export function setupStyleViewer($) {
  const dialog = $('style-dialog');
  const viewport = $('zoom-viewport');
  const image = $('zoom-image');
  let url = '';
  let scale = 1;
  let drag = null;

  function fittedScale() {
    return Math.min(1, viewport.clientWidth / image.naturalWidth, viewport.clientHeight / image.naturalHeight);
  }

  function showScale(value) {
    $('zoom-level').textContent = (value >= 0.1 ? Math.round(value * 100) : (value * 100).toFixed(1)) + '%';
  }

  function showFittedScale() {
    if (dialog.open && viewport.hasAttribute('data-fit') && image.naturalWidth) showScale(fittedScale());
  }

  function fitImage() {
    viewport.setAttribute('data-fit', '');
    image.removeAttribute('style');
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
    showFittedScale();
  }

  function render(next) {
    if (!image.naturalWidth) return;
    const x = image.offsetWidth > viewport.clientWidth
      ? (viewport.scrollLeft + viewport.clientWidth / 2) / image.offsetWidth : 0.5;
    const y = image.offsetHeight > viewport.clientHeight
      ? (viewport.scrollTop + viewport.clientHeight / 2) / image.offsetHeight : 0.5;
    const min = Math.min(fittedScale(), 0.25) / 2;
    scale = Math.max(min, Math.min(4, next));
    viewport.removeAttribute('data-fit');
    image.style.width = Math.max(1, Math.floor(image.naturalWidth * scale)) + 'px';
    image.style.height = Math.max(1, Math.floor(image.naturalHeight * scale)) + 'px';
    viewport.scrollLeft = image.offsetWidth * x - viewport.clientWidth / 2;
    viewport.scrollTop = image.offsetHeight * y - viewport.clientHeight / 2;
    showScale(scale);
  }

  function currentScale() {
    return viewport.hasAttribute('data-fit') && image.naturalWidth ? fittedScale() : scale;
  }

  // CSS fits the image as the sidebar changes size. Only the percentage label needs an update.
  image.addEventListener('load', showFittedScale);
  window.addEventListener('resize', showFittedScale);
  $('zoom-in').addEventListener('click', () => render(currentScale() * 1.25));
  $('zoom-out').addEventListener('click', () => render(currentScale() / 1.25));
  $('zoom-fit').addEventListener('click', fitImage);
  $('zoom-actual').addEventListener('click', () => render(1));

  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target !== image || viewport.hasAttribute('data-fit')) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.setPointerCapture(event.pointerId);
    viewport.dataset.panning = 'true';
  });
  viewport.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId) return;
    viewport.scrollLeft = drag.left + drag.x - event.clientX;
    viewport.scrollTop = drag.top + drag.y - event.clientY;
  });
  viewport.addEventListener('lostpointercapture', () => {
    drag = null;
    delete viewport.dataset.panning;
  });

  dialog.addEventListener('close', () => {
    image.removeAttribute('src');
    if (url) URL.revokeObjectURL(url);
    url = '';
  });

  return style => {
    if (!style || dialog.open) return;
    scale = 1;
    fitImage();
    $('zoom-title').textContent = style.name;
    $('zoom-level').textContent = '';
    image.alt = style.name + ' reference';
    url = URL.createObjectURL(style.blob);
    dialog.showModal();
    image.src = url;
  };
}

