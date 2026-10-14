import type { On, RenderElement } from 'claude-code'

// Draws `/jev` output as Markdown, so the report's tables render as tables.
export function registerView(on: On) {
  on('ui.render', { component: 'CommandOutput', props: { command: 'jev' } }, ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Markdown } = $.ui.resolve(e)
    return h(Markdown, { text: e.props.text }) as RenderElement
  })
}
