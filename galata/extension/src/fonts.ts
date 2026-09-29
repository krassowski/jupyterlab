// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import type {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IMermaidManager } from '@jupyterlab/mermaid';
import { ITerminalTracker } from '@jupyterlab/terminal';
import '@fontsource/dejavu-sans';
import '@fontsource/dejavu-mono';
import '@fontsource-variable/noto-sans-sc';

/**
 * Font families to embed in Mermaid diagrams: the UI font which Mermaid is
 * configured with, see `--jp-ui-font-family` in the Galata default settings.
 */
const MERMAID_FONT_FAMILIES = ['DejaVu Sans'];

const STYLE = `
:root {
  /* Substitute fonts which do not have theme overrides */
  --jp-code-font-family-default: 'DejaVu Mono' !important;
  /* Ensure we have kerning enabled */
  font-kerning: normal;
  -webkit-font-smoothing: none;
  -moz-osx-font-smoothing: none;
  /* Do not let the browser modify the sizing based on the screen size */
  font-optical-sizing: none;
}
`;

export const fontsPlugin: JupyterFrontEndPlugin<void> = {
  id: '@jupyterlab/galata-extension:fonts',
  autoStart: true,
  description:
    'Adds version-pinned fonts for consistent playwright screenshots',
  optional: [ITerminalTracker, IMermaidManager],
  activate: (
    app: JupyterFrontEnd,
    terminalTracker: ITerminalTracker | null,
    mermaidManager: IMermaidManager | null
  ): void => {
    void app.restored.then(() => {
      const style = document.createElement('style');
      style.textContent = STYLE;
      app.shell.node.appendChild(style);
    });

    // Components created with jupyter-ui-toolkit do not respect variable overwrites
    // as the toke system runs independently; we need to set --body-font manually
    const ensureBodyFont = (): void => {
      if (
        document.body.style.getPropertyValue('--body-font') !== '"DejaVu Sans"'
      ) {
        document.body.style.setProperty('--body-font', '"DejaVu Sans"');
      }
    };

    ensureBodyFont();

    const bodyObserver = new MutationObserver(() => {
      ensureBodyFont();
    });

    bodyObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['style']
    });

    // There is no public API to set kerning, rendering, nor antialiasing
    // see https://github.com/xtermjs/xterm.js/issues/2464
    if (terminalTracker) {
      terminalTracker.widgetAdded.connect((_, widget) => {
        const applyCanvasSettings = (canvas: HTMLCanvasElement): void => {
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            return;
          }
          ctx.fontKerning = 'normal';
          ctx.textRendering = 'geometricPrecision';
        };

        const applyToExistingCanvases = (): void => {
          // There may be multiple canvas layers when links extension is enabled
          const canvases = widget.content.node.querySelectorAll('canvas');
          for (const canvas of canvases) {
            applyCanvasSettings(canvas);
          }
        };

        const observer = new MutationObserver(() => {
          applyToExistingCanvases();
        });

        observer.observe(widget.content.node, {
          childList: true,
          subtree: true
        });
        applyToExistingCanvases();

        widget.disposed.connect(() => {
          observer.disconnect();
        });
      });
    }

    if (mermaidManager) {
      embedFontsInMermaidDiagrams(mermaidManager);
    }
  }
};

/**
 * Embed the pinned fonts in each Mermaid diagram.
 *
 * JupyterLab shows a diagram as an SVG image, and an image cannot load the
 * fonts of the page, so without the embedded fonts the diagram text would use
 * the fonts of the operating system.
 */
function embedFontsInMermaidDiagrams(manager: IMermaidManager): void {
  let style: Promise<string> | null = null;
  const renderSvg = manager.renderSvg.bind(manager);
  manager.renderSvg = async (text: string) => {
    const info = await renderSvg(text);
    if (!style) {
      style = inlinedFontFaces(MERMAID_FONT_FAMILIES).then(
        fontFaces => `<style>${fontFaces}</style>`
      );
    }
    const css = await style;
    info.svg = info.svg.replace(/<svg\b[^>]*>/, tag => tag + css);
    return info;
  };
}

/**
 * Get the `@font-face` rules of the page for the given font families, with
 * the font files inlined as data URLs.
 */
async function inlinedFontFaces(families: string[]): Promise<string> {
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      // The rules of a stylesheet from another origin cannot be read
      continue;
    }
    for (const rule of Array.from(cssRules)) {
      if (!(rule instanceof CSSFontFaceRule)) {
        continue;
      }
      const family = rule.style
        .getPropertyValue('font-family')
        .replace(/["']/g, '')
        .trim();
      const url = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(
        rule.style.getPropertyValue('src')
      )?.[1];
      if (!families.includes(family) || !url) {
        continue;
      }
      const response = await fetch(
        new URL(url, sheet.href ?? document.baseURI)
      );
      const data = await readAsDataURL(await response.blob());
      const style = rule.style.getPropertyValue('font-style') || 'normal';
      const weight = rule.style.getPropertyValue('font-weight') || 'normal';
      rules.push(
        `@font-face { font-family: '${family}'; font-style: ${style}; ` +
          `font-weight: ${weight}; src: url(${data}) format('woff2'); }`
      );
    }
  }
  return rules.join('\n');
}

/**
 * Read a font file as a data URL.
 */
function readAsDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // The server may not send a font MIME type, so set it explicitly
      resolve(
        (reader.result as string).replace(/^data:[^;]*;/, 'data:font/woff2;')
      );
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
