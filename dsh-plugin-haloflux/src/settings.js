/**
 * HALOFLUX for DSH — Settings page (`settings.section`).
 *
 * The canvas decoration is configured from two places that must agree:
 *   - the in-page console (C), a floating overlay for quick tweaks;
 *   - this page, a regular Settings section listing every parameter.
 * Both read and write `HalofluxState`, so either one moves the other.
 *
 * The page leads with the data source level (`dataMode`, 0/1/2): level 0 plays
 * the original animation only, level 1 is the shipped mixed look, and level 2
 * draws words and numbers taken from the live session only.
 */
const HalofluxSettings = (() => {
  const h = React.createElement;

  const T_LABEL_1 = 'var(--dsw-alias-label-primary,#e6ecff)';
  const T_LABEL_2 = 'var(--dsw-alias-label-secondary,#8b93a7)';
  const T_LABEL_3 = 'var(--dsw-alias-label-tertiary,#6a7285)';
  const T_ACCENT = 'var(--dsw-alias-brand-primary,#6ea8ff)';
  const T_BORDER = 'color-mix(in srgb,var(--dsw-alias-border-l2,#2a2f3a) 70%,transparent)';
  const FLASH_MS = 1600;

  const CSS = `
.hfx-set{padding:4px 0 12px;color:${T_LABEL_2};font:13px/1.55 inherit;letter-spacing:0}
.hfx-set h2{margin:0 0 2px;font-size:15px;font-weight:600;color:${T_LABEL_1};letter-spacing:0}
.hfx-set .hfx-set-desc{margin:0 0 18px;font-size:12px;line-height:1.6;color:${T_LABEL_3}}
.hfx-set section{margin:0 0 18px}
.hfx-set h3{margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:${T_LABEL_3}}
.hfx-set .hfx-set-card{border:1px solid ${T_BORDER};border-radius:10px;padding:12px 14px;
  background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#0e0f12) 55%,transparent)}
.hfx-set .hfx-set-label{display:block;font-size:13px;color:${T_LABEL_1};margin-bottom:2px}
.hfx-set .hfx-seg{display:inline-flex;gap:2px;padding:2px;margin:8px 0 2px;border-radius:8px;
  background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 55%,transparent);border:1px solid ${T_BORDER}}
.hfx-set .hfx-seg-btn{font:inherit;font-size:12px;letter-spacing:0;cursor:pointer;padding:4px 12px;border-radius:6px;
  color:${T_LABEL_2};background:transparent;border:1px solid transparent}
.hfx-set .hfx-seg-btn:hover{color:${T_LABEL_1}}
.hfx-set .hfx-seg-btn.on{color:#0b0d10;background:${T_ACCENT};border-color:transparent}
.hfx-set .hfx-seg-btn:focus-visible{outline:2px solid ${T_ACCENT};outline-offset:1px}
.hfx-set .hfx-set-hint{display:block;margin-top:6px;font-size:11.5px;line-height:1.6;color:${T_LABEL_3}}
.hfx-set .hfx-set-acts{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.hfx-set .hfx-btn{font:inherit;font-size:12px;letter-spacing:0;cursor:pointer;padding:4px 10px;border-radius:6px;
  color:${T_LABEL_2};background:transparent;border:1px solid ${T_BORDER}}
.hfx-set .hfx-btn:hover{color:${T_LABEL_1};border-color:${T_ACCENT};
  background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.hfx-set .hfx-btn.on{color:#0b0d10;background:${T_ACCENT};border-color:transparent}
.hfx-set .hfx-btn-danger:hover{color:#ff8a8a;border-color:#ff8a8a}
.hfx-set .hfx-ta{box-sizing:border-box;width:100%;height:120px;resize:vertical;margin-top:8px;
  padding:8px 10px;border-radius:8px;border:1px solid ${T_BORDER};
  font:12px/1.5 ui-monospace,Consolas,monospace;letter-spacing:0;
  color:${T_LABEL_1};background:color-mix(in srgb,var(--dsw-alias-bg-base,#0b0d10) 60%,transparent);outline:none}
.hfx-set .hfx-flash{margin-left:auto;font-size:11.5px;letter-spacing:.02em}
.hfx-set .hfx-flash-ok{color:#7ad4a0}
.hfx-set .hfx-flash-err{color:#ff8a8a}
.hfx-set .hfx-flash-copied{color:${T_ACCENT}}
.hfx-set .hfx-set-count{margin-left:6px;font-size:11px;color:${T_LABEL_3};text-transform:none;letter-spacing:0}
`;

  /** Three-way capture level: 0 pure animation, 1 mixed (shipped look), 2 real only. */
  const MODES = [0, 1, 2];

  function ModeSelect(props) {
    const h0 = React.createElement;
    return h0('div', { className: 'hfx-seg', role: 'radiogroup', 'aria-label': props.label },
      MODES.map((mode) => h0('button', {
        key: 'mode-' + mode,
        type: 'button',
        role: 'radio',
        'aria-checked': props.value === mode ? 'true' : 'false',
        className: 'hfx-seg-btn' + (props.value === mode ? ' on' : ''),
        onClick: () => props.onChange(mode),
      }, props.labels[mode])),
    );
  }

  function SettingsPage(props) {
    const t = typeof props.__t === 'function' ? props.__t : (key) => key;
    const params = HalofluxState.useParams();
    const rawMode = Math.round(Number(params.dataMode));
    const mode = rawMode === 0 ? 0 : (rawMode === 2 ? 2 : 1);
    const groups = React.useMemo(() => HalofluxHud.groupEntries(HalofluxHud.readParamEntries()), []);
    const defaults = React.useMemo(() => HalofluxState.baseParams(), []);
    const presets = HalofluxEngine.PRESETS || {};

    const presetNames = React.useMemo(() => {
      const keys = Object.keys(presets);
      const ordered = HalofluxHud.PRESET_ORDER.filter((name) => keys.indexOf(name) >= 0);
      for (const name of keys) if (ordered.indexOf(name) < 0) ordered.push(name);
      return ordered;
    }, [presets]);

    const activePreset = React.useMemo(() => {
      for (const name of presetNames) if (HalofluxHud.matchesPreset(params, presets[name])) return name;
      return '';
    }, [params, presets, presetNames]);

    const [collapsed, setCollapsed] = React.useState(() => {
      const map = {};
      groups.forEach((group, index) => { map[group.name] = index > 0; });
      return map;
    });
    const [importOpen, setImportOpen] = React.useState(false);
    const [importText, setImportText] = React.useState('');
    const [flash, setFlash] = React.useState('');

    const timer = React.useRef(0);
    React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

    const flashTo = React.useCallback((code) => {
      setFlash(code);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { timer.current = 0; setFlash(''); }, FLASH_MS);
    }, []);

    const toggleGroup = React.useCallback((name) => {
      setCollapsed((prev) => {
        const next = Object.assign({}, prev);
        next[name] = !next[name];
        return next;
      });
    }, []);

    const onExport = () => {
      let json = '';
      try { json = HalofluxState.exportJson(); } catch { json = ''; }
      if (!json) { flashTo('err'); return; }
      setImportOpen(true);
      setImportText(json);
      try {
        const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (clip && typeof clip.writeText === 'function') clip.writeText(json).then(() => {}, () => {});
      } catch { /* clipboard blocked: the textarea still holds the JSON */ }
      flashTo('copied');
    };

    const onImport = () => {
      const ok = HalofluxState.importJson(importText);
      flashTo(ok ? 'ok' : 'err');
      if (ok) setImportOpen(false);
    };

    const onSaveDefault = () => {
      try { HalofluxState.saveDefault(); flashTo('ok'); } catch { flashTo('err'); }
    };

    const onReset = () => {
      try { HalofluxState.resetDefault(); flashTo('ok'); } catch { flashTo('err'); }
    };

    const flashText = flash === 'ok' ? t('ui.saved')
      : flash === 'err' ? t('ui.failed')
        : flash === 'copied' ? t('ui.copied') : '';

    return h('div', { className: 'hfx-set' },
      h('style', null, CSS),
      h('h2', null, t('ui.settingsHeading')),
      h('p', { className: 'hfx-set-desc' }, t('ui.settingsDesc')),

      h('section', null,
        h('h3', null, t('ui.dataTitle')),
        h('div', { className: 'hfx-set-card' },
          h('span', { className: 'hfx-set-label' }, t('ui.dataMode')),
          h(ModeSelect, {
            value: mode,
            label: t('ui.dataMode'),
            labels: [t('ui.mode0'), t('ui.mode1'), t('ui.mode2')],
            onChange: (next) => HalofluxState.set({ dataMode: next }),
          }),
          h('span', { className: 'hfx-set-hint' }, t(mode === 0 ? 'ui.mode0Hint' : mode === 1 ? 'ui.mode1Hint' : 'ui.mode2Hint')),
        ),
      ),

      h('section', null,
        h('h3', null, t('ui.configTitle')),
        h('div', { className: 'hfx-set-acts' },
          presetNames.map((name) => h('button', {
            key: 'preset-' + name, type: 'button',
            className: 'hfx-btn' + (name === activePreset ? ' on' : ''),
            title: t('ui.presets') + ': ' + name,
            onClick: () => {
              const preset = presets[name];
              if (preset) HalofluxState.set({ ...preset });
            },
          }, name)),
          h('button', { type: 'button', className: 'hfx-btn', onClick: onExport }, t('ui.export')),
          h('button', {
            type: 'button', className: 'hfx-btn' + (importOpen ? ' on' : ''),
            onClick: () => setImportOpen((open) => !open),
          }, t('ui.import')),
          h('button', { type: 'button', className: 'hfx-btn', onClick: onSaveDefault }, t('ui.saveDefault')),
          h('button', { type: 'button', className: 'hfx-btn hfx-btn-danger', onClick: onReset }, t('ui.reset')),
          flashText ? h('span', { className: 'hfx-flash hfx-flash-' + flash }, flashText) : null,
        ),
        importOpen ? h('textarea', {
          className: 'hfx-ta', value: importText, spellCheck: false,
          placeholder: t('ui.importHint'), 'aria-label': t('ui.import'),
          onChange: (event) => setImportText(event.target.value),
          onKeyDown: (event) => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            onImport();
          },
        }) : null,
        importOpen ? h('div', { className: 'hfx-set-acts', style: { marginTop: 6 } },
          h('button', { type: 'button', className: 'hfx-btn', onClick: onImport }, t('ui.apply')),
        ) : null,
      ),

      h('section', null,
        h('h3', null, t('ui.paramsTitle'),
          h('span', { className: 'hfx-set-count' }, String(HalofluxHud.readParamEntries().length))),
        h('div', { className: 'hfx-params' },
          groups.map((group) => h(HalofluxHud.ParamGroup, {
            key: group.name, group, params, defaults,
            setParams: HalofluxState.set, t,
            collapsed: collapsed[group.name] === true,
            onToggle: () => toggleGroup(group.name),
          })),
        ),
      ),
    );
  }

  return { SettingsPage };
})();
