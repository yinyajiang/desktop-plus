/**
 * localStorage keys shared by the app store and usage stats.
 *
 * These live outside the stores barrel so stats can read them without also
 * loading Copilot and its native koffi binary into the main and crash bundles.
 */
export const useCustomEditorKey = 'use-custom-editor'
export const useCustomShellKey = 'use-custom-shell'

export const underlineLinksKey = 'underline-links'
export const underlineLinksDefault = true

export const showDiffCheckMarksDefault = true
export const showDiffCheckMarksKey = 'diff-check-marks-visible'

export const showChangesFilterKey = 'show-changes-filter'
export const showChangesFilterDefault = true
