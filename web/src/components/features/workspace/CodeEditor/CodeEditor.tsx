import React from 'react'
import { Spinner } from '@fluentui/react'
import MonacoEditor, { type Monaco } from '@monaco-editor/react'
import { KeyMod, KeyCode, type editor, type IKeyboardEvent } from 'monaco-editor'

import { createVimModeAdapter, type StatusBarAdapter, type VimModeKeymap } from '~/plugins/vim/editor'
import { Analyzer } from '~/services/analyzer'
import { TargetType } from '~/services/config'
import { Connect, newMarkerAction, runFileDispatcher } from '~/store'
import { type WorkspaceState, dispatchFormatFile, dispatchResetWorkspace, dispatchUpdateFile } from '~/store/workspace'
import { getTimeNowUsageMarkers, wrapAsyncWithDebounce } from '../utils'
import { attachCustomCommands } from '../commands'
import { LANGUAGE_GOLANG, stateToOptions } from '../props'

const ANALYZE_DEBOUNCE_TIME = 500

interface CodeEditorState {
  code?: string
  loading?: boolean
}

const mapWorkspaceProps = ({ files, selectedFile }: WorkspaceState) => {
  if (!selectedFile) {
    return {
      code: '',
      fileName: '',
    }
  }

  return {
    code: files?.[selectedFile],
    fileName: selectedFile,
  }
}

@Connect(({ workspace, ...s }) => ({
  ...mapWorkspaceProps(workspace),
  darkMode: s.settings.darkMode,
  vimModeEnabled: s.settings.enableVimMode,
  isServerEnvironment: s.runTarget.target === TargetType.Server,
  loading: s.status?.loading,
  options: s.monaco,
  vim: s.vim,
}))
export class CodeEditor extends React.Component<any, CodeEditorState> {
  private analyzer?: Analyzer
  private editorInstance?: editor.IStandaloneCodeEditor
  private vimAdapter?: VimModeKeymap
  private vimCommandAdapter?: StatusBarAdapter
  private monaco?: Monaco

  private readonly debouncedAnalyzeFunc = wrapAsyncWithDebounce(async (fileName: string, code: string) => {
    return await this.doAnalyze(fileName, code)
  }, ANALYZE_DEBOUNCE_TIME)

  editorDidMount(editorInstance: editor.IStandaloneCodeEditor, monacoInstance: Monaco) {
    this.editorInstance = editorInstance
    this.monaco = monacoInstance

    editorInstance.onKeyDown((e) => this.onKeyDown(e))
    const [vimAdapter, statusAdapter] = createVimModeAdapter(this.props.dispatch, editorInstance)
    this.vimAdapter = vimAdapter
    this.vimCommandAdapter = statusAdapter

    if (this.props.vimModeEnabled) {
      console.log('Vim mode enabled')
      this.vimAdapter.attach()
    }

    if (Analyzer.supported()) {
      this.analyzer = new Analyzer()
    } else {
      console.info('Analyzer requires WebAssembly support')
    }

    const actions = [
      {
        id: 'clear',
        label: 'Reset contents',
        contextMenuGroupId: 'navigation',
        run: () => {
          this.props.dispatch(dispatchResetWorkspace)
        },
      },
      {
        id: 'run-code',
        label: 'Build And Run Code',
        contextMenuGroupId: 'navigation',
        keybindings: [KeyMod.CtrlCmd | KeyCode.Enter],
        run: (ed, ...args) => {
          this.props.dispatch(runFileDispatcher)
        },
      },
      {
        id: 'format-code',
        label: 'Format Code (goimports)',
        contextMenuGroupId: 'navigation',
        keybindings: [KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyF],
        run: (ed, ...args) => {
          this.props.dispatch(dispatchFormatFile())
        },
      },
    ]

    // Register custom actions
    actions.forEach((action) => editorInstance.addAction(action))
    attachCustomCommands(editorInstance)
    editorInstance.focus()

    const { fileName, code } = this.props
    void this.debouncedAnalyzeFunc(fileName, code)
  }

  private isFileOrEnvironmentChanged(prevProps) {
    return (
      prevProps.isServerEnvironment !== this.props.isServerEnvironment || prevProps.fileName !== this.props.fileName
    )
  }

  private applyVimModeChanges(prevProps) {
    if (prevProps?.vimModeEnabled === this.props.vimModeEnabled) {
      return
    }

    if (this.props.vimModeEnabled) {
      console.log('Vim mode enabled')
      this.vimAdapter?.attach()
      return
    }

    console.log('Vim mode disabled')
    this.vimAdapter?.dispose()
  }

  componentDidUpdate(prevProps) {
    if (this.isFileOrEnvironmentChanged(prevProps)) {
      // Update editor markers on file or environment changes
      void this.debouncedAnalyzeFunc(this.props.fileName, this.props.code)
    }

    this.applyVimModeChanges(prevProps)
  }

  componentWillUnmount() {
    this.analyzer?.dispose()
    this.vimAdapter?.dispose()

    if (!this.editorInstance) {
      return
    }

    // Shutdown instance to avoid dangling markers.
    this.monaco?.editor.removeAllMarkers(this.editorInstance.getId())
    this.monaco?.editor.getModels().forEach((m) => m.dispose())
    this.editorInstance.dispose()
  }

  onChange(newValue: string | undefined, _: editor.IModelContentChangedEvent) {
    if (!newValue) {
      return
    }

    this.props.dispatch(dispatchUpdateFile(this.props.fileName, newValue))
    const { fileName, code } = this.props
    void this.debouncedAnalyzeFunc(fileName, code)
  }

  private async doAnalyze(fileName: string, code: string) {
    if (!fileName.endsWith('.go')) {
      // Ignore non-go files
      return
    }

    // Code analysis contains 2 steps that run on different conditions:
    // 1. Run Go worker if it's available and check for errors
    // 2. Add warnings to `time.Now` calls if code runs on server.
    const promises = [
      this.analyzer?.getMarkers(code) ?? null,
      this.props.isServerEnvironment ? Promise.resolve(getTimeNowUsageMarkers(code, this.editorInstance!)) : null,
    ].filter((p) => !!p)

    const results = await Promise.allSettled(promises)
    const markers = results.flatMap((r) => {
      // Can't do in beautiful way due of TS strict checks.
      if (r.status === 'rejected') {
        console.error(r.reason)
        return []
      }

      return r.value ?? []
    })

    if (!this.editorInstance) return
    this.monaco?.editor.setModelMarkers(this.editorInstance.getModel()!, this.editorInstance.getId(), markers)
    this.props.dispatch(newMarkerAction(fileName, markers))
  }

  private onKeyDown(e: IKeyboardEvent) {
    const { vimModeEnabled, vim } = this.props
    if (!vimModeEnabled || !vim?.commandStarted) {
      return
    }

    this.vimCommandAdapter?.handleKeyDownEvent(e, vim?.keyBuffer)
  }

  render() {
    const options = stateToOptions(this.props.options)
    return (
      <MonacoEditor
        language={LANGUAGE_GOLANG}
        theme={this.props.darkMode ? 'vs-dark' : 'vs-light'}
        value={this.props.code}
        defaultValue={this.props.code}
        path={this.props.fileName}
        options={options}
        onChange={(newVal, e) => this.onChange(newVal, e)}
        onMount={(e, m) => this.editorDidMount(e, m)}
        loading={<Spinner key="spinner" label="Loading editor..." labelPosition="right" />}
      />
    )
  }
}
