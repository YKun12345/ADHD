(function () {
    'use strict';

    // Only the literal template is parsed. Interpolated values become text nodes;
    // attributes are set separately on DOM nodes and never interpolate HTML.
    function html(strings, ...values) {
        if (!Array.isArray(strings) || !Object.hasOwn(strings, 'raw')) {
            throw new TypeError('Use SafeRender.html as a tagged static template.');
        }
        const template = document.createElement('template');
        template.innerHTML = strings.reduce((markup, part, index) =>
            markup + (index ? `<!--safe-render-text-${index - 1}-->` : '') + part, '');
        const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
        const placeholders = [];
        while (walker.nextNode()) {
            const match = /^safe-render-text-(\d+)$/.exec(walker.currentNode.data);
            if (match) placeholders.push([walker.currentNode, Number(match[1])]);
        }
        if (placeholders.length !== values.length) {
            throw new TypeError('Dynamic attributes are not supported; set them on DOM nodes.');
        }
        placeholders.forEach(([node, index]) => node.replaceWith(document.createTextNode(String(values[index] ?? ''))));
        return template.content;
    }

    function navigationUrl(value) {
        if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
        try {
            const url = new URL(value, window.location.href);
            if (!['http:', 'https:'].includes(url.protocol) || url.origin !== window.location.origin || url.username || url.password) return null;
            return url.href;
        } catch (_) { return null; }
    }

    function imageUrl(value) {
        if (typeof value !== 'string') return null;
        const data = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
        if (data) {
            try {
                const bytes = atob(data[2]);
                const signatures = {
                    png: bytes.startsWith('\x89PNG\r\n\x1a\n'),
                    jpeg: bytes.startsWith('\xff\xd8\xff'),
                    gif: bytes.startsWith('GIF87a') || bytes.startsWith('GIF89a'),
                    webp: bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP'
                };
                return signatures[data[1].toLowerCase()] ? value : null;
            } catch (_) { return null; }
        }
        const url = navigationUrl(value);
        return url && /\.(?:png|jpe?g|gif|webp)$/i.test(new URL(url).pathname) ? url : null;
    }

    function setImage(container, source, alt, fallback = '', style = '') {
        const safeSource = imageUrl(source);
        container.replaceChildren();
        if (!safeSource) {
            container.textContent = fallback;
            return;
        }
        const image = document.createElement('img');
        image.src = safeSource;
        image.alt = String(alt || '截图');
        image.style.cssText = style;
        container.appendChild(image);
    }

    window.SafeRender = Object.freeze({ html, imageUrl, navigationUrl, setImage });
})();
