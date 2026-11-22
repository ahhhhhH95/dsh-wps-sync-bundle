/* WPS cloud sync — DSH client bundle.
 * Plain React without JSX. Only modules provided by window.__ModuleLoader__ are used.
 */
window.__ModuleLoader__.load({
  id: 'dsh-wps-sync-bundle',
  factory(require) {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useId, useMemo, useRef, useState } = React
    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (error) {
      ReactDOM = null
    }

    const NS = 'wps-sync'
    const HTTP_PREFIX = '/api/wps-sync'
    const RPC_CHANNEL = '/wps-sync'
    const TOKEN_HEADER = 'x-wps-sync-token'
    const STATE_TIMEOUT_MS = 20000
    const WRITE_TIMEOUT_MS = 65000
    const ROUTES = new Set(['/state', '/upload', '/auto', '/root', '/remote/list', '/pull', '/restore', '/archive'])
    const AUTH_CODES = new Set(['invalid_token', 'token_expired', 'unauthorized', 'forbidden', 'auth_required'])
    const MAX_PREVIEW_CHARS = 200000
    const ROW_LIMIT = 6
    const IMPORT_LIMIT = 8

    const EN = {
      'panel.title': 'WPS cloud sync',
      'panel.description': 'Connect this profile to a local WPS sync folder. The plugin copies sessions, scheduled tasks, and workspaces as files and never calls WPS servers itself.',
      'panel.loading': 'Loading sync state…',
      'panel.device': 'This device',
      'panel.unknownDevice': 'Unknown device',
      'action.refresh': 'Refresh',
      'action.retry': 'Try again',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.save': 'Save folder',
      'action.chooseFolder': 'Choose folder',
      'action.upload': 'Upload',
      'action.uploadAll': 'Upload everything',
      'action.pull': 'Pull',
      'action.browse': 'Browse',
      'action.restore': 'Restore',
      'action.scan': 'Scan remote',
      'action.scanning': 'Scanning…',
      'action.dismiss': 'Dismiss',
      'action.showAll': 'Show all',
      'action.showLess': 'Show less',
      'section.root.title': 'Sync folder',
      'section.root.description': 'Every copy is written under DSH-Sync in this folder. Choose the WPS sync folder itself; do not pick a subfolder.',
      'section.root.current': 'Current folder',
      'section.root.detected': 'Detected folder',
      'section.root.valid': 'Available',
      'section.root.invalid': 'Unavailable',
      'section.root.unverified': 'Not checked',
      'section.root.notSet': 'Not set',
      'section.root.manual': 'Folder path',
      'section.root.placeholder': 'C:/Users/you/WPS Cloud Files/123456789',
      'section.root.useDetected': 'Use detected folder',
      'section.root.hint': 'Uploads write only inside DSH-Sync. Imported copies are never uploaded again.',
      'section.root.required': 'Set the sync folder first.',
      'section.root.invalidWarning': 'The configured folder is missing or not writable. Choose another folder before uploading.',
      'section.root.wpsHint': 'Keep this folder synced in WPS Office. DSH does not upload to the cloud directly.',
      'section.queue.title': 'Transfer queue',
      'section.queue.description': 'Writes the Host has queued or is running.',
      'section.errors.title': 'Recent problems',
      'section.sessions.title': 'Sessions',
      'section.sessions.description': 'One folder per session with a JSONL transcript, Markdown transcript, and metadata.',
      'section.workspaces.title': 'Workspaces',
      'section.workspaces.description': 'Mirrored workspace folders. A pulled copy can be restored only to a folder you choose.',
      'section.imports.title': 'Staged downloads',
      'section.imports.description': 'Pulled copies stay in imports and are never re-uploaded. Sessions and tasks are read-only archives; only workspaces can be restored.',
      'section.remote.title': 'Remote devices',
      'section.remote.description': 'Devices that synced into the same folder. Pull a copy to stage it here.',
      'tasks.title': 'Scheduled tasks',
      'tasks.description': 'The task catalog is global to this profile.',
      'tasks.rowTitle': 'Task catalog',
      'list.empty.sessions': 'No sessions yet.',
      'list.empty.workspaces': 'No workspaces found.',
      'list.empty.imports': 'Nothing pulled yet.',
      'list.empty.remote': 'No remote copies yet. Scan after another device uploads.',
      'remote.empty': 'No other device has published copies in this folder yet.',
      'list.empty.remoteItems': 'No synced items on this device.',
      'list.noMatch': 'No matches.',
      'list.search': 'Search sessions',
      'list.count': '{count} items',
      'list.capped': 'Showing {shown} of {total}',
      'row.auto': 'Auto',
      'row.autoAria': 'Automatic upload for {title}',
      'row.uploadAria': 'Upload {title}',
      'row.pullAria': 'Pull {title} from {device}',
      'row.updated': 'Updated {time}',
      'row.lastSync': 'Last sync: {time}',
      'row.never': 'Never synced',
      'row.error': 'Last error: {detail}',
      'sync.status.ok': 'Synced',
      'sync.status.never': 'Not synced',
      'sync.status.error': 'Sync failed',
      'queue.idle': 'No transfers running.',
      'queue.count': '{count} entries',
      'queue.state.queued': 'Queued',
      'queue.state.running': 'Running',
      'queue.state.done': 'Done',
      'queue.state.error': 'Failed',
      'queue.unknown': 'Transfer',
      'queue.unknownState': 'Pending',
      'kind.session': 'Session',
      'kind.workspace': 'Workspace',
      'kind.tasks': 'Tasks',
      'kind.all': 'Everything',
      'kind.unknown': 'Archive',
      'header.group': 'WPS sync for this session',
      'header.upload': 'Upload this session',
      'header.uploading': 'Uploading this session…',
      'header.auto': 'Auto',
      'header.autoAria': 'Automatic upload for the current session',
      'header.lastSync': 'Last sync {time}',
      'header.never': 'Not synced yet',
      'header.notListed': 'Not in the recent 200 sessions · state unknown',
      'header.error': 'Sync error',
      'header.busy': 'Loading…',
      'header.stateError': 'State unavailable',
      'header.retry': 'Retry loading sync state',
      'notice.uploaded': 'Uploaded {title}.',
      'notice.uploadedAll': 'Upload requested for all local items.',
      'notice.autoOn': 'Automatic upload enabled for {title}.',
      'notice.autoOff': 'Automatic upload disabled for {title}.',
      'notice.rootSaved': 'Sync folder saved.',
      'notice.pulled': 'Pulled {title} into staged downloads.',
      'notice.restored': 'Restore finished.',
      'error.title': 'Could not load sync state',
      'error.timeout': 'The sync service did not answer in time.',
      'error.network': 'Could not reach the sync service. If DSH was restarted, the Host port changed: reopen the URL printed by dsh web, or press Ctrl+Shift+R in the desktop app.',
      'error.staleEndpoint': 'The sync service is not answering at this address. DSH uses a new Host port after every restart, so this page is probably stale: reopen the URL printed by dsh web, or press Ctrl+Shift+R in the desktop app to load the current bundle again.',
      'error.transport': 'No transport is available. Open DSH through localhost or reload the page.',
      'error.badResponse': 'The sync service returned an unexpected response.',
      'error.badState': 'The sync service returned an invalid state payload.',
      'error.auth': 'The sync token is no longer valid. Refresh the page and try again.',
      'error.upload': 'Upload failed.',
      'error.uploadAll': 'Could not upload everything.',
      'error.auto': 'Could not change automatic upload.',
      'error.root': 'Could not save the sync folder.',
      'error.remote': 'Could not scan remote devices.',
      'error.pull': 'Pull failed.',
      'error.restore': 'Restore failed.',
      'error.archive': 'Could not read the archive.',
      'error.request': 'The sync service rejected the request.',
      'error.render': 'The sync panel crashed. Reload the page and check the Host logs.',
      'root.pickerUnavailable': 'The system folder picker is not available here. Enter the path manually.',
      'root.pickerFailed': 'Could not open the folder picker. {detail}',
      'root.invalidPath': 'Enter the sync folder path first.',
      'remote.ownDevice': 'This device',
      'remote.noDevice': 'This remote item does not name its device. Scan again.',
      'remote.version': 'Version {version}',
      'remote.updated': 'Updated {time}',
      'imports.from': 'From {device}',
      'imports.imported': 'Imported {time}',
      'archive.title': 'Archive: {title}',
      'archive.readOnly': 'Downloaded read-only archive. Runtime import is not supported.',
      'archive.files': 'Files',
      'archive.noFiles': 'This archive lists no files.',
      'archive.loading': 'Loading archive…',
      'archive.loadError': 'Could not load the archive.',
      'archive.truncated': 'Preview truncated. Open the file in the sync folder to read all of it.',
      'archive.selectFile': 'Select a file to preview.',
      'archive.emptyContent': 'This file is empty.',
      'archive.binary': 'This file is binary; preview it in the sync folder.',
      'archive.close': 'Close archive',
      'restore.title': 'Restore workspace',
      'restore.description': 'Choose where the archived files are written. Existing files are never overwritten.',
      'restore.archive': 'Archive',
      'restore.device': 'Source device',
      'restore.target': 'Target folder',
      'restore.targetPlaceholder': 'C:/Users/you/Restored/workspace',
      'restore.targetHint': 'Use an absolute path outside the sync folder.',
      'restore.needTarget': 'Choose a target folder first.',
      'restore.needAbsolute': 'Enter an absolute folder path.',
      'restore.insideRoot': 'The target cannot be the sync folder or a folder inside it.',
      'restore.conflict': 'When a file exists',
      'restore.skip': 'Skip existing files',
      'restore.skipHint': 'The existing file stays untouched.',
      'restore.rename': 'Keep both and rename the incoming file',
      'restore.renameHint': 'Adds a numeric suffix to the restored copy.',
      'restore.submit': 'Restore here',
      'restore.working': 'Restoring…',
      'restore.done': 'Restore finished: {restored} restored, {skipped} skipped, {renamed} renamed.',
      'restore.doneSimple': 'Restore finished.',
      'restore.noOverwrite': 'Overwrite is never offered.',
      'a11y.panel': 'WPS sync management',
      'a11y.refresh': 'Refresh sync state',
      'a11y.chooseFolder': 'Choose the sync folder',
      'a11y.closeDialog': 'Close dialog',
      'a11y.queue': 'Transfer queue',
      'a11y.archiveContent': 'Archive file preview',
      'a11y.statusRegion': 'Sync status',
      'a11y.uploadAll': 'Upload sessions, workspaces, and scheduled tasks',
      'a11y.viewArchive': 'View archive {title}',
      'a11y.search': 'Search sessions by title or ID',
      'a11y.rootStatus': 'Sync folder status',
    }

    const ZH = {
      'panel.title': 'WPS 云盘同步',
      'panel.description': '把当前配置连接到本机 WPS 同步文件夹。插件只把会话、定时任务和工作区复制为文件，不直接调用 WPS 服务器。',
      'panel.loading': '正在加载同步状态…',
      'panel.device': '本机',
      'panel.unknownDevice': '未知设备',
      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.cancel': '取消',
      'action.close': '关闭',
      'action.save': '保存文件夹',
      'action.chooseFolder': '选择文件夹',
      'action.upload': '上传',
      'action.uploadAll': '全部上传',
      'action.pull': '拉取',
      'action.browse': '浏览',
      'action.restore': '恢复',
      'action.scan': '扫描远程',
      'action.scanning': '正在扫描…',
      'action.dismiss': '关闭提示',
      'action.showAll': '显示全部',
      'action.showLess': '收起',
      'section.root.title': '同步文件夹',
      'section.root.description': '所有副本都写入该文件夹内的 DSH-Sync。请选择 WPS 同步文件夹本身，不要选择它的子目录。',
      'section.root.current': '当前文件夹',
      'section.root.detected': '检测到的文件夹',
      'section.root.valid': '可用',
      'section.root.invalid': '不可用',
      'section.root.unverified': '未检查',
      'section.root.notSet': '未设置',
      'section.root.manual': '文件夹路径',
      'section.root.placeholder': 'C:/Users/you/WPS Cloud Files/123456789',
      'section.root.useDetected': '使用检测到的文件夹',
      'section.root.hint': '上传只会写入 DSH-Sync；导入的副本不会再次上传。',
      'section.root.required': '请先设置同步文件夹。',
      'section.root.invalidWarning': '已配置的文件夹不存在或不可写。请先选择其他文件夹再上传。',
      'section.root.wpsHint': '请在 WPS Office 中保持该文件夹同步。DSH 不会直接上传到云端。',
      'section.queue.title': '传输队列',
      'section.queue.description': 'Host 已排队或正在执行的写入。',
      'section.errors.title': '最近的问题',
      'section.sessions.title': '会话',
      'section.sessions.description': '每个会话一个文件夹，包含 JSONL 记录、Markdown 转录和元数据。',
      'section.workspaces.title': '工作区',
      'section.workspaces.description': '工作区目录的镜像副本。拉取的副本只能恢复到显式选择的目标文件夹。',
      'section.imports.title': '暂存档案',
      'section.imports.description': '拉取的副本保存在 imports 中，永远不会再次上传。会话与任务是只读档案，只有工作区可以恢复。',
      'section.remote.title': '远程设备',
      'section.remote.description': '已同步到同一文件夹的设备。拉取后副本会暂存在本机。',
      'tasks.title': '定时任务',
      'tasks.description': '任务目录属于当前配置，全局共享。',
      'tasks.rowTitle': '任务目录',
      'list.empty.sessions': '暂无会话。',
      'list.empty.workspaces': '未找到工作区。',
      'list.empty.imports': '暂无暂存内容。',
      'list.empty.remote': '还没有远程副本。另一台设备上传后再扫描。',
      'remote.empty': '这个文件夹里还没有其他设备发布的副本。',
      'list.empty.remoteItems': '该设备没有已同步条目。',
      'list.noMatch': '没有匹配项。',
      'list.search': '搜索会话',
      'list.count': '{count} 项',
      'list.capped': '显示 {shown} 项，共 {total} 项',
      'row.auto': '自动',
      'row.autoAria': '{title} 的自动上传',
      'row.uploadAria': '上传 {title}',
      'row.pullAria': '从 {device} 拉取 {title}',
      'row.updated': '更新于 {time}',
      'row.lastSync': '最近同步：{time}',
      'row.never': '从未同步',
      'row.error': '最近错误：{detail}',
      'sync.status.ok': '已同步',
      'sync.status.never': '未同步',
      'sync.status.error': '同步失败',
      'queue.idle': '当前没有传输任务。',
      'queue.count': '共 {count} 项',
      'queue.state.queued': '排队中',
      'queue.state.running': '进行中',
      'queue.state.done': '已完成',
      'queue.state.error': '失败',
      'queue.unknown': '传输',
      'queue.unknownState': '等待中',
      'kind.session': '会话',
      'kind.workspace': '工作区',
      'kind.tasks': '任务',
      'kind.all': '全部',
      'kind.unknown': '档案',
      'header.group': '当前会话的 WPS 同步',
      'header.upload': '上传当前会话',
      'header.uploading': '正在上传当前会话…',
      'header.auto': '自动',
      'header.autoAria': '当前会话的自动上传',
      'header.lastSync': '最近同步 {time}',
      'header.never': '尚未同步',
      'header.notListed': '该会话不在最近 200 条内，状态未知',
      'header.error': '同步出错',
      'header.busy': '加载中…',
      'header.stateError': '状态不可用',
      'header.retry': '重试加载同步状态',
      'notice.uploaded': '已上传 {title}。',
      'notice.uploadedAll': '已请求上传全部本地条目。',
      'notice.autoOn': '已为 {title} 开启自动上传。',
      'notice.autoOff': '已为 {title} 关闭自动上传。',
      'notice.rootSaved': '同步文件夹已保存。',
      'notice.pulled': '已将 {title} 拉取到暂存档案。',
      'notice.restored': '恢复完成。',
      'error.title': '无法加载同步状态',
      'error.timeout': '同步服务响应超时。',
      'error.network': '无法连接同步服务。若 DSH 刚重启过，Host 端口会变化：请重新打开 dsh web 打印的 URL，或在桌面应用中按 Ctrl+Shift+R 强制刷新。',
      'error.staleEndpoint': '此地址上的同步服务没有响应。DSH 每次重启都会更换 Host 端口，当前页面很可能已过期：请重新打开 dsh web 打印的 URL，或在桌面应用中按 Ctrl+Shift+R 重新加载当前 bundle。',
      'error.transport': '没有可用的传输通道。请通过 localhost 打开 DSH 或重新加载页面。',
      'error.badResponse': '同步服务返回了意外的响应。',
      'error.badState': '同步服务返回了无效的状态数据。',
      'error.auth': '同步令牌已失效，请刷新页面后重试。',
      'error.upload': '上传失败。',
      'error.uploadAll': '无法上传全部条目。',
      'error.auto': '无法修改自动上传设置。',
      'error.root': '无法保存同步文件夹。',
      'error.remote': '无法扫描远程设备。',
      'error.pull': '拉取失败。',
      'error.restore': '恢复失败。',
      'error.archive': '无法读取档案。',
      'error.request': '同步服务拒绝了请求。',
      'error.render': '同步面板渲染失败。请重新加载页面并检查 Host 日志。',
      'root.pickerUnavailable': '当前环境无法调用系统文件夹选择器，请手动输入路径。',
      'root.pickerFailed': '无法打开文件夹选择器。{detail}',
      'root.invalidPath': '请先输入同步文件夹路径。',
      'remote.ownDevice': '当前设备',
      'remote.noDevice': '远程条目没有标明所属设备，请重新扫描。',
      'remote.version': '版本 {version}',
      'remote.updated': '更新于 {time}',
      'imports.from': '来自 {device}',
      'imports.imported': '导入于 {time}',
      'archive.title': '档案：{title}',
      'archive.readOnly': '已下载的只读档案，不支持运行时导入。',
      'archive.files': '文件',
      'archive.noFiles': '该档案没有文件列表。',
      'archive.loading': '正在读取档案…',
      'archive.loadError': '无法读取档案。',
      'archive.truncated': '预览已截断。请在同步文件夹中打开完整文件。',
      'archive.selectFile': '选择要预览的文件。',
      'archive.emptyContent': '该文件为空。',
      'archive.binary': '该文件是二进制文件，请在同步文件夹中预览。',
      'archive.close': '关闭档案',
      'restore.title': '恢复工作区',
      'restore.description': '选择档案文件的写入位置。不会覆盖任何已有文件。',
      'restore.archive': '档案',
      'restore.device': '来源设备',
      'restore.target': '目标文件夹',
      'restore.targetPlaceholder': 'C:/Users/you/Restored/workspace',
      'restore.targetHint': '请使用同步文件夹之外的绝对路径。',
      'restore.needTarget': '请先选择目标文件夹。',
      'restore.needAbsolute': '请输入绝对路径。',
      'restore.insideRoot': '目标文件夹不能是同步文件夹或其子目录。',
      'restore.conflict': '文件已存在时',
      'restore.skip': '跳过已有文件',
      'restore.skipHint': '现有文件保持不变。',
      'restore.rename': '保留两者，重命名新文件',
      'restore.renameHint': '为恢复的副本添加数字后缀。',
      'restore.submit': '恢复到此处',
      'restore.working': '正在恢复…',
      'restore.done': '恢复完成：已恢复 {restored} 个，跳过 {skipped} 个，重命名 {renamed} 个。',
      'restore.doneSimple': '恢复完成。',
      'restore.noOverwrite': '不提供覆盖选项。',
      'a11y.panel': 'WPS 同步管理',
      'a11y.refresh': '刷新同步状态',
      'a11y.chooseFolder': '选择同步文件夹',
      'a11y.closeDialog': '关闭对话框',
      'a11y.queue': '当前传输队列',
      'a11y.archiveContent': '档案文件预览',
      'a11y.statusRegion': '同步状态',
      'a11y.uploadAll': '上传会话、工作区与定时任务',
      'a11y.viewArchive': '查看档案 {title}',
      'a11y.search': '按标题或 ID 搜索会话',
      'a11y.rootStatus': '同步文件夹状态',
    }

    function interpolate(template, params) {
      const text = typeof template === 'string' ? template : ''
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => {
        const value = params[name]
        return value === undefined || value === null ? match : String(value)
      })
    }

    function fallbackTranslate(key, params) {
      try {
        if (appCtx && appCtx.locale && typeof appCtx.locale.bind === 'function') {
          return appCtx.locale.bind(NS)(key, params)
        }
      } catch (error) {
        // Fall back to the bundled English dictionary.
      }
      return interpolate(EN[key] || key, params)
    }

    function pickT(props) {
      return props && typeof props.t === 'function' ? props.t : fallbackTranslate
    }

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asString(value) {
      return typeof value === 'string' ? value : ''
    }

    function asNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    function pick(record, keys) {
      if (!isRecord(record)) return undefined
      for (const key of keys) {
        const value = record[key]
        if (value !== undefined && value !== null) return value
      }
      return undefined
    }

    function toTime(value) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value > 1000000000000 ? value : value > 1000000000 ? value * 1000 : value
      }
      if (typeof value === 'string' && value.trim()) {
        const numeric = Number(value)
        if (Number.isFinite(numeric) && numeric > 0) return toTime(numeric)
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : 0
      }
      return 0
    }

    function formatTime(value, localeId) {
      const time = toTime(value)
      if (!time) return ''
      const date = new Date(time)
      try {
        return new Intl.DateTimeFormat(localeId || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      } catch (error) {
        return date.toLocaleString()
      }
    }

    function formatBytes(value, localeId) {
      const number = asNumber(value)
      if (!number) return ''
      const units = ['B', 'KB', 'MB', 'GB']
      let index = 0
      let size = number
      while (size >= 1024 && index < units.length - 1) {
        size = size / 1024
        index += 1
      }
      try {
        return new Intl.NumberFormat(localeId || undefined, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(size) + ' ' + units[index]
      } catch (error) {
        return size.toFixed(index === 0 ? 0 : 1) + ' ' + units[index]
      }
    }

    function errorMessage(value) {
      if (typeof value === 'string') return value
      if (value && typeof value === 'object') {
        return asString(value.message) || asString(value.code) || ''
      }
      return ''
    }

    function normalizeItemEntry(value) {
      if (value === undefined || value === null) return null
      if (typeof value === 'string') {
        const time = toTime(value)
        if (time) return { auto: false, lastSyncAt: time, lastResult: '', lastError: '' }
        return { auto: false, lastSyncAt: 0, lastResult: '', lastError: value }
      }
      if (typeof value === 'number') {
        return { auto: false, lastSyncAt: toTime(value), lastResult: '', lastError: '' }
      }
      if (!isRecord(value)) return null
      const lastError = pick(value, ['lastError', 'error', 'failure'])
      return {
        auto: value.auto === true || value.autoSync === true || value.enabled === true,
        lastSyncAt: toTime(pick(value, ['lastSyncAt', 'syncedAt', 'lastUploadAt', 'uploadedAt', 'at', 'time'])),
        lastResult: asString(pick(value, ['lastResult', 'result', 'status', 'message'])),
        lastError: errorMessage(lastError),
      }
    }

    function normalizeEntry(entry, kind) {
      if (typeof entry === 'string') {
        return { id: entry, title: entry, path: '', updatedAt: 0, createdAt: 0, messageCount: 0 }
      }
      if (!isRecord(entry)) return null
      const idKeys = kind === 'session' ? ['id', 'sessionId', 'key'] : ['id', 'workspaceId', 'key', 'path']
      const id = asString(pick(entry, idKeys))
      const path = asString(pick(entry, ['path', 'cwd', 'subtitle', 'directory', 'root', 'dir']))
      const title = asString(pick(entry, ['title', 'name', 'label', 'slug', 'basename'])) || id || path
      const finalId = id || path
      if (!finalId) return null
      return {
        id: finalId,
        title,
        path,
        updatedAt: toTime(pick(entry, ['updatedAt', 'updated', 'lastActivityAt', 'mtime', 'createdAt'])),
        createdAt: toTime(pick(entry, ['createdAt', 'created'])),
        messageCount: asNumber(pick(entry, ['messageCount', 'eventCount', 'events'])),
      }
    }

    function normalizeTasks(rawTasks, items) {
      let info = isRecord(rawTasks) ? rawTasks : {}
      if (typeof rawTasks === 'number') info = { count: rawTasks }
      const item = items['tasks:global'] || items.tasks || items.global || null
      const list = Array.isArray(info.tasks) ? info.tasks : Array.isArray(info.items) ? info.items : []
      return {
        id: asString(pick(info, ['id'])) || 'global',
        auto: typeof info.auto === 'boolean' ? info.auto : item ? item.auto : false,
        lastSyncAt: toTime(pick(info, ['lastSyncAt', 'updatedAt', 'syncedAt'])) || (item ? item.lastSyncAt : 0),
        lastResult: asString(pick(info, ['lastResult', 'message'])) || (item ? item.lastResult : ''),
        lastError: errorMessage(pick(info, ['lastError', 'error'])) || (item ? item.lastError : ''),
        count: asNumber(pick(info, ['count', 'total', 'taskCount'])) || list.length,
      }
    }

    function normalizeDevice(raw) {
      if (typeof raw === 'string' && raw) return { id: raw, name: raw, platform: '' }
      if (!isRecord(raw)) return null
      const id = asString(pick(raw, ['id', 'deviceId', 'key']))
      if (!id) return null
      return {
        id,
        name: asString(pick(raw, ['name', 'label', 'hostname'])) || id,
        platform: asString(pick(raw, ['platform', 'os', 'system'])),
      }
    }

    function normalizeQueue(raw) {
      const list = Array.isArray(raw)
        ? raw
        : isRecord(raw) && Array.isArray(raw.items)
          ? raw.items
          : isRecord(raw) && Array.isArray(raw.jobs)
            ? raw.jobs
            : []
      return list
        .map((entry, index) => {
          if (typeof entry === 'string') {
            return { key: 'queue-' + index, kind: '', id: '', title: entry, state: '', startedAt: 0, error: '' }
          }
          if (!isRecord(entry)) return null
          const key = asString(pick(entry, ['key', 'itemKey']))
          const id = asString(pick(entry, ['id', 'jobId', 'sessionId', 'workspaceId'])) || key
          const label = asString(pick(entry, ['label', 'title', 'name']))
          return {
            key: key || id || 'queue-' + index,
            kind: asString(pick(entry, ['kind', 'type', 'job'])),
            id,
            title: label || key || id,
            state: asString(pick(entry, ['state', 'status', 'phase'])),
            startedAt: toTime(pick(entry, ['startedAt', 'createdAt', 'queuedAt', 'at', 'time'])),
            error: errorMessage(pick(entry, ['error', 'lastError', 'message'])),
          }
        })
        .filter(Boolean)
    }

    function normalizeErrors(raw) {
      let list = []
      if (Array.isArray(raw)) list = raw
      else if (isRecord(raw) && raw.message) list = [raw]
      else if (isRecord(raw)) list = Object.values(raw)
      return list
        .map((entry) => {
          if (typeof entry === 'string') return { message: entry, at: 0, code: '' }
          if (!isRecord(entry)) return null
          return {
            message: errorMessage(entry) || asString(pick(entry, ['detail', 'reason'])),
            at: toTime(pick(entry, ['at', 'time', 'timestamp', 'createdAt'])),
            code: asString(pick(entry, ['code', 'kind'])),
          }
        })
        .filter((entry) => entry && entry.message)
        .slice(-20)
    }

    function normalizeImports(raw) {
      const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.items) ? raw.items : []
      return list
        .map((entry) => {
          if (!isRecord(entry)) return null
          const importId = asString(pick(entry, ['importId', 'importID', 'id', 'key']))
          if (!importId) return null
          const deviceRaw = pick(entry, ['device', 'sourceDevice'])
          const device = isRecord(deviceRaw) ? normalizeDevice(deviceRaw) : null
          const deviceId = asString(pick(entry, ['deviceId', 'sourceDeviceId'])) || (device ? device.id : '')
          const kind = asString(pick(entry, ['kind', 'type'])) || 'unknown'
          return {
            importId,
            kind,
            id: asString(pick(entry, ['id', 'itemId', 'sourceId'])),
            title: asString(pick(entry, ['title', 'name', 'label', 'slug'])) || asString(pick(entry, ['id'])) || importId,
            deviceId,
            deviceName: asString(pick(entry, ['deviceName'])) || (device ? device.name : '') || deviceId,
            importedAt: toTime(pick(entry, ['importedAt', 'createdAt', 'at', 'time'])),
            path: asString(pick(entry, ['path', 'dir'])),
            size: asNumber(pick(entry, ['size', 'bytes'])),
            version: asString(pick(entry, ['version'])) || (typeof entry.version === 'number' ? String(entry.version) : ''),
          }
        })
        .filter(Boolean)
    }

    function normalizeRemoteItem(entry, deviceId) {
      if (!isRecord(entry)) return null
      const kind = asString(pick(entry, ['kind', 'type'])) || 'unknown'
      const id = asString(pick(entry, ['id', 'itemId', 'sessionId', 'workspaceId', 'key']))
      if (!id) return null
      const versionRaw = pick(entry, ['version', 'rev', 'hash'])
      return {
        kind,
        id,
        title: asString(pick(entry, ['title', 'name', 'label', 'slug'])) || id,
        version: typeof versionRaw === 'number' ? String(versionRaw) : asString(versionRaw),
        updatedAt: toTime(pick(entry, ['exportedAt', 'updatedAt', 'updated', 'mtime', 'createdAt'])),
        size: asNumber(pick(entry, ['sizeBytes', 'size', 'bytes'])),
        deviceId: asString(pick(entry, ['deviceId'])) || deviceId || '',
      }
    }

    function normalizeRemoteDevice(entry, fallbackId) {
      if (!isRecord(entry)) return null
      const id = asString(pick(entry, ['id', 'deviceId', 'key'])) || fallbackId || ''
      const itemsRaw = Array.isArray(entry.items) ? entry.items : Array.isArray(entry.entries) ? entry.entries : []
      return {
        id,
        name: asString(pick(entry, ['name', 'label', 'hostname'])) || id,
        platform: asString(pick(entry, ['platform', 'os', 'system'])),
        lastSeenAt: toTime(pick(entry, ['lastSeenAt', 'updatedAt', 'at'])),
        items: itemsRaw.map((item) => normalizeRemoteItem(item, id)).filter(Boolean),
      }
    }

    function normalizeRemote(raw) {
      if (!isRecord(raw)) return { devices: [] }
      const devicesRaw = pick(raw, ['devices', 'hosts'])
      const flatItems = asArray(pick(raw, ['items', 'entries']))
      const devices = []
      if (Array.isArray(devicesRaw)) {
        for (const entry of devicesRaw) {
          const device = normalizeRemoteDevice(entry, '')
          if (device) devices.push(device)
        }
      } else if (isRecord(devicesRaw)) {
        for (const [id, entry] of Object.entries(devicesRaw)) {
          const device = normalizeRemoteDevice(isRecord(entry) ? entry : {}, id)
          if (device) devices.push(device)
        }
      }
      if (devices.length === 0 && flatItems.length > 0) {
        devices.push({
          id: '',
          name: '',
          platform: '',
          lastSeenAt: 0,
          items: flatItems.map((item) => normalizeRemoteItem(item, '')).filter(Boolean),
        })
      }
      for (const device of devices) {
        if (device.items.length === 0 && flatItems.length > 0) {
          device.items = flatItems
            .filter((item) => isRecord(item) && asString(pick(item, ['deviceId'])) === device.id)
            .map((item) => normalizeRemoteItem(item, device.id))
            .filter(Boolean)
        }
      }
      return { devices: devices.filter((device) => device.items.length > 0 || device.id) }
    }

    function normalizeState(raw) {
      const root = isRecord(raw) ? raw : {}
      const items = {}
      if (Array.isArray(root.items)) {
        for (const entry of root.items) {
          if (!isRecord(entry)) continue
          const entryKind = asString(entry.kind)
          const entryId = asString(pick(entry, ['id', 'key']))
          if (!entryKind || !entryId) continue
          const item = normalizeItemEntry(entry)
          if (item) items[entryKind + ':' + entryId] = item
        }
      } else if (isRecord(root.items)) {
        for (const [key, value] of Object.entries(root.items)) {
          const item = normalizeItemEntry(value)
          if (item) items[key] = item
        }
      }
      for (const kind of ['session', 'workspace', 'tasks']) {
        const group = root.items && root.items[kind + 's']
        if (isRecord(group)) {
          for (const [id, value] of Object.entries(group)) {
            const item = normalizeItemEntry(value)
            if (item) items[kind + ':' + id] = item
          }
        }
      }
      // The Host exposes per-item sync state through the `sessions`,
      // `workspaces` and single `tasks` records, not through an `items` map.
      const seedItems = (kind, list) => {
        for (const entry of asArray(list)) {
          if (!isRecord(entry)) continue
          const id = asString(pick(entry, ['id', 'key'])) || asString(pick(entry, ['sessionId', 'workspaceId']))
          if (!id) continue
          const item = normalizeItemEntry(entry)
          if (item) items[kind + ':' + id] = item
        }
      }
      seedItems('session', root.sessions)
      seedItems('workspace', root.workspaces)
      if (isRecord(root.tasks)) {
        const taskItem = normalizeItemEntry(root.tasks)
        if (taskItem) {
          items['tasks:global'] = taskItem
          const taskId = asString(root.tasks.id)
          if (taskId) items['tasks:' + taskId] = taskItem
        }
      }
      const validRaw = pick(root, ['syncRootValid', 'rootValid', 'syncRootExists'])
      const importsRaw = pick(root, ['imports', 'staged', 'archives'])
      return {
        syncRootDir: asString(pick(root, ['syncRootDir', 'syncRoot', 'rootDir', 'root'])),
        detectedRootDir: asString(pick(root, ['detectedRootDir', 'detectedRoot', 'suggestedRootDir'])),
        syncRootValid: typeof validRaw === 'boolean' ? validRaw : null,
        device: normalizeDevice(pick(root, ['device', 'currentDevice'])),
        sessions: asArray(root.sessions).map((entry) => normalizeEntry(entry, 'session')).filter(Boolean),
        workspaces: asArray(root.workspaces).map((entry) => normalizeEntry(entry, 'workspace')).filter(Boolean),
        tasks: normalizeTasks(root.tasks, items),
        items,
        queue: normalizeQueue(pick(root, ['queue', 'transfers'])),
        errors: normalizeErrors(root.errors),
        imports: normalizeImports(importsRaw),
      }
    }

    function itemFor(state, kind, id) {
      if (!state || !state.items) return null
      const keys = kind === 'tasks'
        ? ['tasks:global', 'tasks', 'global', 'tasks:' + (id || 'global')]
        : [kind + ':' + id, id, kind + '/' + id]
      for (const key of keys) {
        if (state.items[key]) return state.items[key]
      }
      const groups = state.items[kind + 's']
      if (isRecord(groups) && id && groups[id]) return normalizeItemEntry(groups[id])
      return null
    }

    function normalizeArchive(payload) {
      if (typeof payload === 'string') return { files: [], path: '', content: payload, truncated: false }
      let root = isRecord(payload) ? payload : {}
      if (isRecord(root.archive)) root = Object.assign({}, root, root.archive)
      let filesRaw = []
      for (const key of ['files', 'entries', 'tree', 'listing']) {
        if (Array.isArray(root[key])) {
          filesRaw = root[key]
          break
        }
        if (isRecord(root[key])) {
          filesRaw = Object.entries(root[key]).map(([path, value]) => (isRecord(value) ? Object.assign({ path }, value) : { path, size: value }))
          break
        }
      }
      const files = filesRaw
        .map((entry) => {
          if (typeof entry === 'string') return { path: entry, size: 0 }
          if (!isRecord(entry)) return null
          const path = asString(pick(entry, ['path', 'name', 'file', 'relativePath']))
          if (!path) return null
          return {
            path,
            size: asNumber(pick(entry, ['size', 'bytes'])),
            directory: entry.directory === true || entry.type === 'directory',
          }
        })
        .filter(Boolean)
      let content = ''
      if (typeof root.content === 'string') content = root.content
      else if (root.content !== undefined && root.content !== null) {
        try {
          content = JSON.stringify(root.content, null, 2)
        } catch (error) {
          content = String(root.content)
        }
      } else if (typeof root.text === 'string') {
        content = root.text
      }
      return {
        files: files.filter((file) => !file.directory),
        path: asString(pick(root, ['path', 'file', 'relativePath'])),
        content,
        binary: root.binary === true,
        truncated: root.truncated === true,
      }
    }

    function preferredArchiveFile(files, kind) {
      const patterns = kind === 'tasks'
        ? [/scheduled-tasks\.json$/i, /\.json$/i, /\.jsonl$/i, /\.md$/i]
        : [/transcript\.md$/i, /session\.jsonl$/i, /meta\.json$/i]
      for (const pattern of patterns) {
        const found = files.find((file) => pattern.test(file.path))
        if (found) return found.path
      }
      return files.length ? files[0].path : ''
    }

    function kindLabel(t, kind) {
      if (kind === 'session' || kind === 'workspace' || kind === 'tasks' || kind === 'all') return t('kind.' + kind)
      return kind || t('kind.unknown')
    }

    function queueStateLabel(t, state) {
      const key = asString(state).toLowerCase()
      if (key === 'queued' || key === 'pending' || key === 'waiting') return t('queue.state.queued')
      if (key === 'running' || key === 'active' || key === 'working') return t('queue.state.running')
      if (key === 'done' || key === 'success' || key === 'ok' || key === 'completed') return t('queue.state.done')
      if (key === 'error' || key === 'failed' || key === 'failure') return t('queue.state.error')
      return state ? state : t('queue.unknownState')
    }

    function queueTone(state) {
      const key = asString(state).toLowerCase()
      if (key === 'error' || key === 'failed' || key === 'failure') return 'error'
      if (key === 'running' || key === 'active' || key === 'working') return 'brand'
      if (key === 'done' || key === 'success' || key === 'ok' || key === 'completed') return 'ok'
      return 'muted'
    }

    function errorText(error, t) {
      if (!error) return ''
      const code = asString(error.code)
      if (code === 'no_transport') return t('error.transport')
      if (code === 'timeout') return t('error.timeout')
      if (code === 'network') return t('error.network')
      if (code === 'stale_endpoint') return t('error.staleEndpoint')
      if (code === 'bad_response') {
        const detail = asString(error.message)
        return detail ? t('error.badResponse') + ' (' + detail + ')' : t('error.badResponse')
      }
      if (code === 'bad_state') return t('error.badState')
      if (error.auth === true || AUTH_CODES.has(code)) return t('error.auth')
      const message = asString(error.message)
      return message || t('error.request')
    }

    function normalizePath(value) {
      return asString(value).trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    }

    function isPathInside(target, root) {
      const normalizedTarget = normalizePath(target)
      const normalizedRoot = normalizePath(root)
      if (!normalizedTarget || !normalizedRoot) return false
      return normalizedTarget === normalizedRoot || normalizedTarget.indexOf(normalizedRoot + '/') === 0
    }

    function isAbsolutePath(value) {
      const path = asString(value).trim()
      if (!path) return false
      if (/^[a-zA-Z]:[\\/]/.test(path)) return true
      if (/^\\\\[^\\]+\\/.test(path)) return true
      return path.charAt(0) === '/'
    }

    function countOf(record, keys) {
      if (!isRecord(record)) return 0
      for (const key of keys) {
        const value = record[key]
        if (Array.isArray(value)) return value.length
        if (typeof value === 'number' && Number.isFinite(value)) return value
      }
      return 0
    }

    function summarizeRestore(value) {
      const record = isRecord(value) ? (isRecord(value.result) ? value.result : value) : {}
      const restored = countOf(record, ['restored', 'restoredFiles', 'written', 'restoredCount', 'copied'])
      const skipped = countOf(record, ['skipped', 'skippedFiles', 'skippedCount'])
      const renamed = countOf(record, ['renamed', 'renamedFiles', 'renamedCount'])
      const hasCounts = ['restored', 'restoredFiles', 'written', 'restoredCount', 'copied', 'skipped', 'skippedFiles', 'skippedCount', 'renamed', 'renamedFiles', 'renamedCount'].some((key) => key in record)
      return { restored, skipped, renamed, hasCounts }
    }

    function uploadKey(kind, id) {
      return 'upload:' + kind + ':' + (id || '')
    }

    function autoKey(kind, id) {
      return 'auto:' + kind + ':' + (id || '')
    }

    function pullKey(deviceId, kind, id) {
      return 'pull:' + deviceId + ':' + kind + ':' + id
    }

    let appCtx = null

    function getLocaleId() {
      try {
        return appCtx && appCtx.locale && typeof appCtx.locale.getSnapshot === 'function'
          ? appCtx.locale.getSnapshot().active
          : undefined
      } catch (error) {
        return undefined
      }
    }

    async function pickDirectory(t) {
      try {
        const remote = appCtx && appCtx.remote && appCtx.remote.directoryPicker
        if (remote && typeof remote.pick === 'function') {
          const result = await remote.pick()
          if (result === null || result === undefined) return { status: 'cancel' }
          if (typeof result === 'string') return result ? { status: 'ok', path: result } : { status: 'cancel' }
          if (isRecord(result)) {
            if (result.ok === false) {
              return { status: 'error', error: new Error(errorMessage(result.error) || t('root.pickerFailed', { detail: '' })) }
            }
            if (result.ok === true) {
              return typeof result.value === 'string' && result.value ? { status: 'ok', path: result.value } : { status: 'cancel' }
            }
            if (typeof result.value === 'string' && result.value) return { status: 'ok', path: result.value }
          }
          return { status: 'cancel' }
        }
        const bridge = typeof globalThis !== 'undefined' ? globalThis.__DSH_DIRECTORY_PICKER__ : null
        if (bridge && typeof bridge.pick === 'function') {
          const value = await bridge.pick()
          return typeof value === 'string' && value ? { status: 'ok', path: value } : { status: 'cancel' }
        }
        const workspace = appCtx && appCtx.uiWorkspace
        if (workspace && typeof workspace.pickDirectory === 'function') {
          const value = await workspace.pickDirectory()
          return typeof value === 'string' && value ? { status: 'ok', path: value } : { status: 'cancel' }
        }
        return { status: 'unavailable' }
      } catch (error) {
        return { status: 'error', error }
      }
    }

    class WpsError extends Error {
      constructor(code, message, extra) {
        super(message)
        this.name = 'WpsError'
        this.code = code
        if (extra) Object.assign(this, extra)
      }
    }

    function extractHttpError(body) {
      if (!body) return null
      if (typeof body === 'string') return { code: '', message: body }
      if (!isRecord(body)) return null
      const error = body.error
      if (typeof error === 'string') return { code: asString(body.code), message: error }
      if (isRecord(error)) return { code: asString(error.code), message: errorMessage(error) }
      if (body.message) return { code: asString(body.code), message: errorMessage(body) }
      return null
    }

    function httpError(status, body) {
      const extracted = extractHttpError(body)
      const code = extracted && extracted.code ? extracted.code : 'http'
      const message = extracted && extracted.message ? extracted.message : 'HTTP ' + status
      const error = new WpsError(code, message)
      error.status = status
      error.auth = status === 401 || status === 403 || AUTH_CODES.has(code)
      return error
    }

    const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i
    const DESKTOP_SCHEME = /^dsh(?:-app)?:$/i
    /** Messages Chromium/Firefox/Node emit when a socket-level connection fails. */
    const NETWORK_LAYER_PATTERN = /failed to fetch|fetch failed|network\s?error|network request failed|load failed|econnrefused|econnreset|econnaborted|enotfound|ehostunreach|enetunreach|epipe|err_connection|err_network|connection (?:refused|reset|closed)|socket hang up|net::err_/i

    function readLocation(location, field) {
      try {
        return location ? String(location[field] || '') : ''
      } catch (error) {
        return ''
      }
    }

    /** `dsh web`: the document itself is served from a loopback http(s) origin. */
    function isLoopbackHttpLocation(location) {
      if (!location) return false
      return /^https?:$/.test(readLocation(location, 'protocol')) && LOOPBACK_HOST.test(readLocation(location, 'hostname'))
    }

    /**
     * Desktop renderer: `dsh-app://app/` is the document origin and the Electron
     * protocol handler forwards every other path to the live Host port. Only the
     * privileged `app` host is proxied; `dsh-app://shell` serves the document shell
     * and `dsh-app://evil` would be a different origin, so both stay excluded.
     */
    function isDesktopAppLocation(location) {
      if (!location) return false
      return DESKTOP_SCHEME.test(readLocation(location, 'protocol')) && readLocation(location, 'hostname').toLowerCase() === 'app'
    }

    /**
     * True for TypeError/"Failed to fetch"/ECONNREFUSED-style failures, which after
     * a Host restart normally mean the page still points at the dead port.
     */
    function isNetworkLayerFailure(error) {
      if (!error) return false
      const name = typeof error.name === 'string' ? error.name : ''
      if (name === 'TypeError' || name === 'NetworkError') return true
      const code = typeof error.code === 'string' ? error.code : ''
      const message = typeof error.message === 'string' ? error.message : ''
      const cause = error.cause && typeof error.cause === 'object' ? error.cause : null
      const causeText = cause && typeof cause.message === 'string' ? cause.message : ''
      return NETWORK_LAYER_PATTERN.test(code) || NETWORK_LAYER_PATTERN.test(message) || NETWORK_LAYER_PATTERN.test(causeText)
    }

    function networkError(error) {
      const name = error && typeof error.name === 'string' ? error.name : ''
      if (name === 'TimeoutError' || name === 'AbortError') return new WpsError('timeout', 'The request timed out.')
      const message = error && error.message ? error.message : 'Network request failed.'
      // A socket-level failure usually means this page is still talking to the
      // Host port from before the last DSH restart, so name that cause instead of
      // the generic `network` copy and tell the user how to recover.
      if (isNetworkLayerFailure(error)) return new WpsError('stale_endpoint', message)
      return new WpsError('network', message)
    }

    function isAuthError(error) {
      return !!error && (error.auth === true || AUTH_CODES.has(asString(error.code)))
    }

    function buildSignal(timeoutMs) {
      try {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
          return AbortSignal.timeout(timeoutMs)
        }
      } catch (error) {
        return undefined
      }
      return undefined
    }

    function resolveRpc(rpcGetter) {
      try {
        const rpc = typeof rpcGetter === 'function' ? rpcGetter() : null
        return rpc && typeof rpc.call === 'function' ? rpc : null
      } catch (error) {
        return null
      }
    }

    function createTransport(rpcGetter) {
      let token = ''

      function acceptState(body) {
        if (!isRecord(body) || typeof body.token !== 'string' || !body.token) {
          throw new WpsError('bad_state', 'GET /state did not return a token.')
        }
        token = body.token
        const state = Object.assign({}, body)
        delete state.token
        delete state.ok
        return state
      }

      function requestFailure(body) {
        const error = body && body.error
        const code = error && typeof error === 'object' ? asString(error.code) || 'request' : 'request'
        const message = errorMessage(error) || 'The sync service rejected the request.'
        const wrapped = new WpsError(code, message)
        wrapped.auth = AUTH_CODES.has(code) || /token|unauthori[sz]ed|forbidden|auth/i.test(code)
        return wrapped
      }

      /** Both the Host `{ok,result}` envelope and the legacy `{status,body}` one. */
      function unwrapResult(body) {
        if (body === null || body === undefined) return body
        if (!isRecord(body)) return body
        if (body.ok === false) throw requestFailure(body)
        if (Object.prototype.hasOwnProperty.call(body, 'result')) return body.result
        if (Number.isInteger(body.status) && Object.prototype.hasOwnProperty.call(body, 'body')) {
          if (body.status < 200 || body.status >= 300) throw httpError(body.status, body.body)
          return body.body
        }
        return body
      }

      function resolveFetcher() {
        const globals = typeof globalThis !== 'undefined' ? globalThis : null
        if (!globals) return null
        const carrier = globals.__DSH_TRANSPORT__
        if (carrier && typeof carrier.fetch === 'function') {
          return { fetch: carrier.fetch.bind(carrier), kind: 'carrier' }
        }
        let location = null
        try {
          location = globals.location || null
        } catch (error) {
          location = null
        }
        // Desktop renderer: the window loads `dsh-app://app/` and the main process
        // proxies every other path (including `/api/*`) to the live Host port, so a
        // relative URL stays same-origin and needs no CORS or absolute base.
        const desktop = !!carrier && carrier.ownsHost === true && isDesktopAppLocation(location)
        // `dsh web` in a browser: the page itself is the Host origin.
        const web = isLoopbackHttpLocation(location)
        if ((desktop || web) && typeof globals.fetch === 'function') {
          return { fetch: globals.fetch.bind(globals), kind: desktop ? 'desktop' : 'window' }
        }
        return null
      }

      async function sendHttp(fetcher, route, input) {
        const method = input === undefined ? 'GET' : 'POST'
        const headers = { accept: 'application/json' }
        if (input !== undefined) headers['content-type'] = 'application/json'
        if (token && route !== '/state') headers[TOKEN_HEADER] = token
        const options = {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers,
          signal: buildSignal(route === '/state' ? STATE_TIMEOUT_MS : WRITE_TIMEOUT_MS),
        }
        if (input !== undefined) options.body = JSON.stringify(input)
        let response
        try {
          response = await fetcher.fetch(HTTP_PREFIX + route, options)
        } catch (error) {
          throw networkError(error)
        }
        let body = null
        if (response.status !== 204) {
          let text = ''
          try {
            text = await response.text()
          } catch (error) {
            text = ''
          }
          if (text) {
            try {
              body = JSON.parse(text)
            } catch (error) {
              if (response.ok) throw new WpsError('bad_response', 'HTTP ' + response.status + ' did not return JSON.')
              body = null
            }
          }
        }
        if (!response.ok) throw httpError(response.status, body)
        if (route === '/state') return acceptState(body)
        return unwrapResult(body)
      }

      const RPC_ACTIONS = {
        '/state': 'status',
        '/upload': 'upload',
        '/auto': 'auto',
        '/root': 'root',
        '/remote/list': 'remoteList',
        '/pull': 'pull',
        '/restore': 'restore',
        '/archive': 'archive',
      }

      async function sendRpc(rpc, route, input) {
        // The Host bridge reads `action` + `args`; the earlier `{path,input}`
        // envelope is kept in the payload so either bridge implementation works.
        const payload = {
          path: route,
          action: RPC_ACTIONS[route] || route.replace(/^\//, ''),
          args: input === undefined ? {} : input,
        }
        if (input !== undefined) payload.input = input
        if (token && route !== '/state') payload.token = token
        let reply
        try {
          reply = await rpc.call(RPC_CHANNEL, 'request', payload, buildSignal(route === '/state' ? STATE_TIMEOUT_MS : WRITE_TIMEOUT_MS))
        } catch (error) {
          throw networkError(error)
        }
        if (!reply) throw requestFailure(null)
        // Host bridges answer with `{type,rpcId,result:{ok,value}}`; older
        // shapes put `{ok,value}` at the top level. Accept both.
        const outcome = isRecord(reply.result) ? reply.result : reply
        if (outcome.ok === false) throw requestFailure(outcome)
        const value = Object.prototype.hasOwnProperty.call(outcome, 'value') ? outcome.value : outcome
        if (route === '/state') {
          // The HTTP bridge returns the bearer; the RPC bridge may rely on
          // connection admission instead and return a bare status snapshot.
          if (isRecord(value) && typeof value.token === 'string' && value.token) return acceptState(value)
          const state = isRecord(value) ? Object.assign({}, value) : {}
          delete state.token
          delete state.ok
          return state
        }
        return unwrapResult(value)
      }

      async function send(route, input) {
        const fetcher = resolveFetcher()
        if (fetcher) return sendHttp(fetcher, route, input)
        const rpc = resolveRpc(rpcGetter)
        if (rpc) return sendRpc(rpc, route, input)
        throw new WpsError('no_transport', 'No HTTP or RPC transport is available.')
      }

      async function request(route, input) {
        if (!ROUTES.has(route)) throw new WpsError('bad_response', 'Unknown route: ' + route)
        if (route !== '/state' && input !== undefined && !token) {
          await send('/state', undefined)
        }
        try {
          return await send(route, input)
        } catch (error) {
          if (route !== '/state' && isAuthError(error)) {
            token = ''
            try {
              await send('/state', undefined)
            } catch (refreshError) {
              throw error
            }
            return await send(route, input)
          }
          throw error
        }
      }

      return {
        state: () => request('/state'),
        upload: (input) => request('/upload', input),
        auto: (input) => request('/auto', input),
        root: (input) => request('/root', input),
        remoteList: () => request('/remote/list', {}),
        pull: (input) => request('/pull', input),
        restore: (input) => request('/restore', input),
        archive: (input) => request('/archive', input),
      }
    }

    function createStore(rpcGetter) {
      const transport = createTransport(rpcGetter)
      let snapshot = {
        phase: 'idle',
        state: null,
        error: null,
        busy: {},
        notice: null,
        actionError: null,
        remote: null,
        remotePhase: 'idle',
        remoteError: null,
      }
      const listeners = new Set()
      let loadPromise = null
      let remotePromise = null

      function getSnapshot() {
        return snapshot
      }

      function subscribe(listener) {
        listeners.add(listener)
        return function unsubscribe() {
          listeners.delete(listener)
        }
      }

      function emit(patch) {
        snapshot = Object.assign({}, snapshot, patch)
        for (const listener of listeners) {
          try {
            listener()
          } catch (error) {
            if (typeof console !== 'undefined') console.error('[wps-sync] listener failed', error)
          }
        }
      }

      function setBusy(key, value) {
        const busy = Object.assign({}, snapshot.busy)
        if (value) busy[key] = true
        else delete busy[key]
        emit({ busy })
      }

      function refresh() {
        if (loadPromise) return loadPromise
        const hadState = !!snapshot.state
        emit({ phase: hadState ? 'refreshing' : 'loading', error: null })
        loadPromise = (async () => {
          try {
            const raw = await transport.state()
            const next = normalizeState(raw)
            emit({ phase: 'ready', state: next, error: null })
            return next
          } catch (error) {
            emit({ phase: 'error', error })
            throw error
          } finally {
            loadPromise = null
          }
        })()
        return loadPromise
      }

      async function refreshQuietly() {
        try {
          await refresh()
        } catch (error) {
          // The snapshot carries the error for the UI.
        }
      }

      function ensureLoaded() {
        if (snapshot.phase === 'ready' || snapshot.phase === 'loading' || snapshot.phase === 'refreshing') return
        if (snapshot.phase === 'error' && snapshot.state) return
        refresh().catch(() => {})
      }

      async function perform(key, task, notice, errorKey) {
        if (snapshot.busy[key]) return { ok: false, busy: true }
        setBusy(key, true)
        emit({ actionError: null, notice: null })
        try {
          const value = await task()
          if (notice) emit({ notice: typeof notice === 'function' ? notice(value) : notice })
          await refreshQuietly()
          return { ok: true, value }
        } catch (error) {
          emit({ actionError: { key: errorKey, error, busyKey: key } })
          return { ok: false, error }
        } finally {
          setBusy(key, false)
        }
      }

      function upload(kind, id, label) {
        const input = { kind }
        if (id) input.id = id
        const key = uploadKey(kind, id)
        return perform(key, () => transport.upload(input), { tone: 'ok', key: 'notice.uploaded', params: { title: label || id || kindLabel(fallbackTranslate, kind) } }, 'error.upload')
      }

      function uploadAll() {
        return perform('upload:all', () => transport.upload({ kind: 'all' }), { tone: 'ok', key: 'notice.uploadedAll' }, 'error.uploadAll')
      }

      function setAuto(kind, id, auto, label) {
        const input = { kind, auto: !!auto }
        if (id) input.id = id
        return perform(
          autoKey(kind, id),
          () => transport.auto(input),
          {
            tone: 'ok',
            key: auto ? 'notice.autoOn' : 'notice.autoOff',
            params: { title: label || id || kindLabel(fallbackTranslate, kind) },
          },
          'error.auto',
        )
      }

      function setRoot(dir) {
        return perform('root', () => transport.root({ syncRootDir: dir }), { tone: 'ok', key: 'notice.rootSaved' }, 'error.root')
      }

      function loadRemote() {
        if (remotePromise) return remotePromise
        emit({ remotePhase: 'loading', remoteError: null })
        remotePromise = (async () => {
          try {
            const raw = await transport.remoteList()
            const remote = normalizeRemote(raw)
            emit({ remote, remotePhase: 'ready', remoteError: null })
            return remote
          } catch (error) {
            // The Host dispatch table names this action `remoteList`, so the
            // HTTP suffix `/remote/list` can answer "unknown action". The
            // status snapshot already carries the same remote payload, so use
            // it instead of failing the whole section.
            try {
              const state = await transport.state()
              if (isRecord(state) && isRecord(state.remote)) {
                const remote = normalizeRemote(state.remote)
                emit({ remote, remotePhase: 'ready', remoteError: null })
                return remote
              }
            } catch (fallbackError) {
              // Fall through to the original failure.
            }
            emit({ remotePhase: 'error', remoteError: error })
            throw error
          } finally {
            remotePromise = null
          }
        })()
        return remotePromise
      }

      function pull(deviceId, kind, id, version, label) {
        const input = { deviceId, kind, id }
        if (version !== undefined && version !== null && version !== '') input.version = version
        return perform(
          pullKey(deviceId, kind, id),
          () => transport.pull(input),
          { tone: 'ok', key: 'notice.pulled', params: { title: label || id } },
          'error.pull',
        )
      }

      function restore(importId, targetDir, conflict) {
        return perform(
          'restore:' + importId,
          () => transport.restore({ importId, targetDir, conflict }),
          { tone: 'ok', key: 'notice.restored' },
          'error.restore',
        )
      }

      function archive(importId, path) {
        const input = { importId }
        if (path) input.path = path
        return transport.archive(input)
      }

      return {
        getSnapshot,
        subscribe,
        ensureLoaded,
        refresh,
        upload,
        uploadAll,
        setAuto,
        setRoot,
        loadRemote,
        pull,
        restore,
        archive,
        dismissNotice() {
          emit({ notice: null })
        },
        dismissActionError() {
          emit({ actionError: null })
        },
      }
    }

    const store = createStore(() => {
      try {
        const connection = appCtx && (typeof appCtx.get === 'function' ? appCtx.get('connection') : appCtx.connection)
        return connection && connection.rpc ? connection.rpc : null
      } catch (error) {
        return null
      }
    })

    const ICONS = {
      refresh: [
        ['M20 12a8 8 0 1 1-2.34-5.66', {}],
        ['M20 4.5v5h-5', {}],
      ],
      upload: [
        ['M12 16V4', {}],
        ['m6.5 9.5 5.5-5.5 5.5 5.5', {}],
        ['M5 20h14', {}],
      ],
      download: [
        ['M12 4v12', {}],
        ['m6.5 10.5 5.5 5.5 5.5-5.5', {}],
        ['M5 20h14', {}],
      ],
      folder: [
        ['M3.5 7.5a2 2 0 0 1 2-2h3l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z', {}],
      ],
      close: [
        ['M6 6l12 12', {}],
        ['M18 6 6 18', {}],
      ],
      alert: [
        ['M12 8v5', {}],
        ['M12 16.5h.01', {}],
        ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', {}],
      ],
      check: [
        ['m5 12.5 4.5 4.5L19 7', {}],
      ],
      file: [
        ['M7 3.5h7l4 4v13H7z', {}],
        ['M14 3.5v4h4', {}],
      ],
      device: [
        ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', {}],
        ['M3.5 12h17', {}],
        ['M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z', {}],
      ],
      search: [
        ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', {}],
        ['m15.5 15.5 4.5 4.5', {}],
      ],
    }

    function Icon(props) {
      const name = props.name
      const size = props.size || 14
      const paths = ICONS[name] || []
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        paths.map((entry, index) => h('path', Object.assign({ key: index, d: entry[0] }, entry[1]))),
      )
    }

    function Button(props) {
      const variant = props.variant || 'secondary'
      const size = props.size || 'md'
      const busy = props.busy === true
      const disabled = props.disabled === true || busy
      const className = 'wps-sync-btn wps-sync-btn--' + variant + (size === 'sm' ? ' wps-sync-btn--sm' : '')
      return h(
        'button',
        {
          type: 'button',
          className,
          onClick: disabled ? undefined : props.onClick,
          disabled,
          title: props.title,
          'aria-label': props.ariaLabel,
          'aria-busy': busy ? 'true' : undefined,
        },
        busy ? h('span', { className: 'wps-sync-spinner', 'aria-hidden': 'true' }) : props.icon ? h(Icon, { name: props.icon }) : null,
        props.children,
      )
    }

    function IconButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'wps-sync-icon-btn' + (props.className ? ' ' + props.className : ''),
          onClick: props.disabled ? undefined : props.onClick,
          disabled: props.disabled === true,
          title: props.title || props.label,
          'aria-label': props.label,
        },
        props.children || h(Icon, { name: props.icon || 'close' }),
      )
    }

    function Switch(props) {
      const checked = props.checked === true
      return h(
        'span',
        { className: 'wps-sync-switch-wrap' + (props.compact ? ' wps-sync-switch-wrap--compact' : '') },
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': props.ariaLabel,
            className: 'wps-sync-switch',
            disabled: props.disabled === true || props.busy === true,
            onClick: () => props.onChange(!checked),
          },
          h('span', { className: 'wps-sync-switch-thumb', 'aria-hidden': 'true' }),
        ),
        props.label ? h('span', { className: 'wps-sync-switch-label', 'aria-hidden': 'true' }, props.label) : null,
      )
    }

    const TextInput = React.forwardRef(function TextInput(props, ref) {
      return h('input', {
        id: props.id,
        ref,
        type: 'text',
        className: 'wps-sync-input' + (props.mono ? ' wps-sync-input--mono' : ''),
        value: props.value,
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        autoFocus: props.autoFocus === true,
        spellCheck: false,
        autoComplete: 'off',
        'aria-label': props.ariaLabel,
        'aria-invalid': props.invalid ? 'true' : undefined,
        'aria-describedby': props.describedBy,
        'data-autofocus': props.autoFocus ? 'true' : undefined,
        onChange: (event) => props.onChange(event.target.value),
        onKeyDown: props.onKeyDown,
      })
    })

    function Badge(props) {
      return h('span', { className: 'wps-sync-badge wps-sync-badge--' + (props.tone || 'muted') }, props.children)
    }

    function Banner(props) {
      const tone = props.tone || 'info'
      return h(
        'div',
        { className: 'wps-sync-banner wps-sync-banner--' + tone, role: tone === 'error' ? 'alert' : 'status' },
        h(
          'div',
          { className: 'wps-sync-banner-content' },
          props.title ? h('p', { className: 'wps-sync-banner-title' }, props.title) : null,
          props.children ? h('div', { className: 'wps-sync-banner-body' }, props.children) : null,
        ),
        props.onDismiss
          ? h(IconButton, { label: props.dismissLabel || 'Dismiss', onClick: props.onDismiss, className: 'wps-sync-banner-dismiss', icon: 'close' })
          : null,
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'wps-sync-empty' },
        h('p', { className: 'wps-sync-empty-title' }, props.title),
        props.body ? h('p', { className: 'wps-sync-help' }, props.body) : null,
      )
    }

    function Card(props) {
      return h(
        'section',
        { className: 'wps-sync-card' + (props.className ? ' ' + props.className : '') },
        h(
          'div',
          { className: 'wps-sync-card-head' },
          h(
            'div',
            { className: 'wps-sync-card-heading' },
            h('h3', { className: 'wps-sync-h3' }, props.title),
            props.help ? h('p', { className: 'wps-sync-help' }, props.help) : null,
          ),
          props.actions ? h('div', { className: 'wps-sync-card-actions' }, props.actions) : null,
        ),
        h('div', { className: 'wps-sync-card-body' }, props.children),
      )
    }

    function Spinner() {
      return h('span', { className: 'wps-sync-spinner', 'aria-hidden': 'true' })
    }

    function useWpsStore() {
      const [snap, setSnap] = useState(() => store.getSnapshot())
      useEffect(() => {
        return store.subscribe(() => setSnap(store.getSnapshot()))
      }, [])
      return snap
    }

    const STYLES = `
      .wps-sync-panel {
        display: flex;
        flex-direction: column;
        gap: 14px;
        color: var(--dsw-alias-label-primary);
        font-size: 13px;
        line-height: 1.5;
        min-width: 0;
      }
      .wps-sync-panel *, .wps-sync-modal * { box-sizing: border-box; }
      .wps-sync-top {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        flex-wrap: wrap;
      }
      .wps-sync-top-text { min-width: 0; flex: 1 1 280px; }
      .wps-sync-title { margin: 0; font-size: 16px; line-height: 1.3; font-weight: 600; }
      .wps-sync-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); max-width: 72ch; font-size: 12px; }
      .wps-sync-top-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wps-sync-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        min-height: 24px;
        padding: 2px 9px;
        border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l2);
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-base);
        font-size: 12px;
        max-width: 260px;
      }
      .wps-sync-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wps-sync-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); flex: none; }
      .wps-sync-dot--ok { background: var(--dsw-alias-state-success-primary); }
      .wps-sync-dot--warn { background: var(--dsw-alias-state-warn-primary); }
      .wps-sync-dot--error { background: var(--dsw-alias-state-error-primary); }
      .wps-sync-columns {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
        gap: 12px;
        align-items: start;
      }
      .wps-sync-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        min-width: 0;
        padding: 12px 14px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 12px;
        background: var(--dsw-alias-bg-layer-1);
      }
      .wps-sync-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
      .wps-sync-card-heading { min-width: 0; }
      .wps-sync-card-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; flex: none; }
      .wps-sync-card-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
      .wps-sync-h3 { margin: 0; font-size: 13px; font-weight: 600; }
      .wps-sync-help { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .wps-sync-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        min-height: 28px;
        padding: 5px 10px;
        font: inherit;
        font-size: 12px;
        line-height: 1.2;
        white-space: nowrap;
        border-radius: 8px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-base);
        color: var(--dsw-alias-label-primary);
        cursor: pointer;
      }
      .wps-sync-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
      .wps-sync-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .wps-sync-btn:disabled { opacity: 0.5; cursor: default; }
      .wps-sync-btn--sm { min-height: 26px; padding: 4px 8px; font-size: 12px; }
      .wps-sync-btn--primary {
        background: var(--dsw-alias-button-primary-fill);
        color: var(--dsw-alias-label-primary-inverted);
        border-color: transparent;
      }
      .wps-sync-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .wps-sync-btn--ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
      .wps-sync-btn--ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .wps-sync-icon-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        flex: none;
      }
      .wps-sync-icon-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .wps-sync-icon-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .wps-sync-icon-btn:disabled { opacity: 0.45; cursor: default; }
      .wps-sync-switch-wrap { display: inline-flex; align-items: center; gap: 6px; flex: none; }
      .wps-sync-switch {
        appearance: none;
        position: relative;
        width: 34px;
        height: 20px;
        padding: 3px;
        border-radius: 999px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-mask-3);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        flex: none;
      }
      .wps-sync-switch[aria-checked="true"] { background: var(--dsw-alias-state-success-primary); border-color: transparent; }
      .wps-sync-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .wps-sync-switch:disabled { opacity: 0.5; cursor: default; }
      .wps-sync-switch-thumb {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--dsw-alias-switch-thumb);
        transform: translateX(0);
        transition: transform 0.15s ease;
        display: block;
      }
      .wps-sync-switch[aria-checked="true"] .wps-sync-switch-thumb { transform: translateX(14px); }
      .wps-sync-switch-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .wps-sync-input {
        font: inherit;
        font-size: 12px;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-bg-base);
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 8px;
        padding: 6px 9px;
        width: 100%;
        min-height: 30px;
      }
      .wps-sync-input::placeholder { color: var(--dsw-alias-label-tertiary); }
      .wps-sync-input:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .wps-sync-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
      .wps-sync-input--mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
      .wps-sync-code {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary);
        overflow-wrap: anywhere;
      }
      .wps-sync-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
      .wps-sync-row {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
        padding: 8px 9px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        background: var(--dsw-alias-bg-base);
        min-width: 0;
      }
      .wps-sync-row-main { flex: 1 1 190px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
      .wps-sync-row-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wps-sync-row-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--dsw-alias-label-tertiary); font-size: 11px; min-width: 0; }
      .wps-sync-row-meta > span { overflow-wrap: anywhere; }
      .wps-sync-row-error { color: var(--dsw-alias-state-error-primary); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .wps-sync-row-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: none; }
      .wps-sync-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 999px;
        padding: 1px 7px;
        font-size: 11px;
        line-height: 1.5;
        color: var(--dsw-alias-label-secondary);
        background: var(--dsw-alias-bg-base);
        white-space: nowrap;
        flex: none;
      }
      .wps-sync-badge--ok { color: var(--dsw-alias-state-success-primary); }
      .wps-sync-badge--error { color: var(--dsw-alias-state-error-primary); }
      .wps-sync-badge--warn { color: var(--dsw-alias-state-warn-primary); }
      .wps-sync-badge--brand { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .wps-sync-banner {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 9px 11px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1);
        font-size: 12px;
      }
      .wps-sync-banner--error { border-color: var(--dsw-alias-state-error-primary); }
      .wps-sync-banner--warn { border-color: var(--dsw-alias-state-warn-primary); }
      .wps-sync-banner--ok { border-color: var(--dsw-alias-state-success-primary); }
      .wps-sync-banner--info { border-color: var(--dsw-alias-border-l2); }
      .wps-sync-banner-content { flex: 1 1 auto; min-width: 0; }
      .wps-sync-banner-title { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
      .wps-sync-banner-body { margin: 2px 0 0; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
      .wps-sync-banner-dismiss { margin-left: auto; }
      .wps-sync-empty {
        display: flex;
        flex-direction: column;
        gap: 3px;
        align-items: flex-start;
        padding: 10px;
        border: 1px dashed var(--dsw-alias-border-l2);
        border-radius: 10px;
        color: var(--dsw-alias-label-tertiary);
        font-size: 12px;
      }
      .wps-sync-empty-title { margin: 0; }
      .wps-sync-spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        border: 2px solid var(--dsw-alias-border-l3);
        border-top-color: var(--dsw-alias-label-primary);
        animation: wps-sync-spin 0.8s linear infinite;
        flex: none;
      }
      @keyframes wps-sync-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) {
        .wps-sync-spinner { animation-duration: 2.4s; }
        .wps-sync-switch-thumb { transition: none; }
      }
      .wps-sync-search { display: flex; }
      .wps-sync-more { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wps-sync-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .wps-sync-field-label { font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary); }
      .wps-sync-field-hint { margin: 0; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .wps-sync-field-row { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
      .wps-sync-field-row > .wps-sync-input { flex: 1 1 220px; width: auto; }
      .wps-sync-kv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .wps-sync-kv-label { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
      .wps-sync-root-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wps-sync-root-line > code { overflow-wrap: anywhere; }
      .wps-sync-text-error { color: var(--dsw-alias-state-error-primary); }
      .wps-sync-queue { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .wps-sync-queue-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wps-sync-plain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
      .wps-sync-error-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .wps-sync-error-row > span { flex: 1 1 200px; overflow-wrap: anywhere; }
      .wps-sync-error-row > time { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
      .wps-sync-device { display: flex; flex-direction: column; gap: 7px; padding-top: 4px; }
      .wps-sync-device + .wps-sync-device { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 10px; }
      .wps-sync-device-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .wps-sync-device-name { font-weight: 500; }
      .wps-sync-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: var(--dsw-alias-bg-mask-1);
      }
      .wps-sync-modal {
        width: min(560px, 100%);
        max-height: min(82vh, 760px);
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 18px;
        border-radius: 14px;
        border: 1px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1);
        color: var(--dsw-alias-label-primary);
        box-shadow: 0 18px 48px var(--dsw-alias-bg-mask-1);
      }
      .wps-sync-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
      .wps-sync-modal-title { margin: 0; font-size: 15px; font-weight: 600; }
      .wps-sync-modal-desc { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .wps-sync-modal-body { display: flex; flex-direction: column; gap: 12px; }
      .wps-sync-modal-footer { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
      .wps-sync-fieldset { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 6px; }
      .wps-sync-radio {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 9px;
        cursor: pointer;
        font-size: 12px;
      }
      .wps-sync-radio:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .wps-sync-radio input { margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
      .wps-sync-radio-text { display: flex; flex-direction: column; gap: 1px; }
      .wps-sync-radio-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
      .wps-sync-archive { gap: 10px; }
      .wps-sync-archive-grid { display: grid; grid-template-columns: minmax(150px, 230px) minmax(0, 1fr); gap: 10px; align-items: start; }
      .wps-sync-filelist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; max-height: 320px; overflow: auto; }
      .wps-sync-file {
        appearance: none;
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 5px 7px;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        font: inherit;
        font-size: 11px;
        text-align: left;
        cursor: pointer;
        min-width: 0;
      }
      .wps-sync-file:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .wps-sync-file:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -1px; }
      .wps-sync-file[aria-current="true"] { background: var(--dsw-alias-interactive-bg-active); color: var(--dsw-alias-label-primary); }
      .wps-sync-file-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
      .wps-sync-file-size { margin-left: auto; color: var(--dsw-alias-label-tertiary); font-size: 10px; flex: none; }
      .wps-sync-pre {
        margin: 0;
        padding: 10px;
        border-radius: 9px;
        background: var(--dsw-alias-markdown-code-block);
        color: var(--dsw-alias-label-primary);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        line-height: 1.45;
        max-height: 420px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .wps-sync-pre:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .wps-sync-loading { display: flex; align-items: center; gap: 8px; padding: 14px; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
      .wps-sync-sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .wps-sync-header { display: inline-flex; align-items: center; gap: 4px; min-height: 28px; }
      .wps-sync-header-btn {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 7px;
        background: transparent;
        color: var(--dsw-alias-label-secondary);
        cursor: pointer;
        flex: none;
      }
      .wps-sync-header-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
      .wps-sync-header-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .wps-sync-header-btn:disabled { opacity: 0.45; cursor: default; }
      .wps-sync-header-switch .wps-sync-switch { width: 30px; height: 18px; padding: 3px; }
      .wps-sync-header-switch .wps-sync-switch-thumb { width: 10px; height: 10px; }
      .wps-sync-header-switch .wps-sync-switch[aria-checked="true"] .wps-sync-switch-thumb { transform: translateX(12px); }
      .wps-sync-header-caption {
        max-width: 96px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary);
      }
      .wps-sync-header-caption-wide { max-width: min(200px, 42vw); }
      .wps-sync-header-error { color: var(--dsw-alias-state-error-primary); }
      @media (max-width: 640px) {
        .wps-sync-archive-grid { grid-template-columns: 1fr; }
        .wps-sync-modal { padding: 14px; }
      }
    `

    function ensureStyles() {
      if (typeof document === 'undefined') return function noop() {}
      const existing = document.getElementById('dsh-wps-sync-styles')
      if (existing) return function noop() {}
      const element = document.createElement('style')
      element.id = 'dsh-wps-sync-styles'
      element.textContent = STYLES
      document.head.appendChild(element)
      return function removeStyles() {
        if (element.parentNode) element.parentNode.removeChild(element)
      }
    }

    function Modal(props) {
      const open = props.open === true
      const titleId = useId()
      const descId = useId()
      const dialogRef = useRef(null)
      const stateRef = useRef({ onClose: props.onClose, busy: props.busy === true })
      stateRef.current.onClose = props.onClose
      stateRef.current.busy = props.busy === true

      useEffect(() => {
        if (!open || typeof document === 'undefined') return undefined
        const previous = document.activeElement
        const body = document.body
        const previousOverflow = body.style.overflow
        body.style.overflow = 'hidden'
        const node = dialogRef.current
        const focusable = () => {
          if (!node) return []
          return Array.prototype.slice
            .call(node.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
            .filter((element) => element.offsetParent !== null || element === document.activeElement)
        }
        const initial = node ? node.querySelector('[data-autofocus="true"]') : null
        const target = initial || focusable()[0]
        if (target && typeof target.focus === 'function') target.focus()
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!stateRef.current.busy && typeof stateRef.current.onClose === 'function') {
              event.preventDefault()
              stateRef.current.onClose()
            }
            return
          }
          if (event.key !== 'Tab') return
          const items = focusable()
          if (items.length === 0) {
            event.preventDefault()
            return
          }
          if (!node || !node.contains(document.activeElement)) {
            event.preventDefault()
            const fallback = event.shiftKey ? items[items.length - 1] : items[0]
            if (fallback) fallback.focus()
            return
          }
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return function cleanup() {
          document.removeEventListener('keydown', onKeyDown, true)
          body.style.overflow = previousOverflow
          if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
            try {
              previous.focus()
            } catch (error) {
              // The previous element can disappear while the dialog is open.
            }
          }
        }
      }, [open])

      if (!open) return null
      const content = h(
        'div',
        {
          className: 'wps-sync-modal-backdrop',
          onMouseDown: (event) => {
            if (event.target === event.currentTarget && !stateRef.current.busy && typeof stateRef.current.onClose === 'function') {
              stateRef.current.onClose()
            }
          },
        },
        h(
          'div',
          {
            className: 'wps-sync-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': titleId,
            'aria-describedby': props.description ? descId : undefined,
            ref: dialogRef,
            onMouseDown: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'wps-sync-modal-head' },
            h(
              'div',
              { className: 'wps-sync-modal-heading' },
              h('h2', { className: 'wps-sync-modal-title', id: titleId }, props.title),
              props.description ? h('p', { className: 'wps-sync-modal-desc', id: descId }, props.description) : null,
            ),
            h(IconButton, {
              label: props.t ? props.t('a11y.closeDialog') : 'Close dialog',
              icon: 'close',
              onClick: props.onClose,
              disabled: props.busy === true,
            }),
          ),
          h('div', { className: 'wps-sync-modal-body' }, props.children),
          props.footer ? h('div', { className: 'wps-sync-modal-footer' }, props.footer) : null,
        ),
      )
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(content, document.body)
      }
      return content
    }

    function SyncRow(props) {
      const t = props.t
      const snap = useWpsStore()
      const id = props.id || ''
      const item = props.item !== undefined ? props.item : itemFor(snap.state, props.kind, id)
      const uploadBusy = !!snap.busy[uploadKey(props.kind, id)]
      const autoBusy = !!snap.busy[autoKey(props.kind, id)]
      const lastSyncAt = item ? item.lastSyncAt : 0
      const lastText = lastSyncAt ? t('row.lastSync', { time: formatTime(lastSyncAt, props.localeId) }) : t('row.never')
      const meta = asArray(props.meta).filter(Boolean)
      const uploadLabel = t('row.uploadAria', { title: props.title })
      return h(
        'li',
        { className: 'wps-sync-row' },
        h(
          'div',
          { className: 'wps-sync-row-main' },
          h('span', { className: 'wps-sync-row-title', title: props.title }, props.title),
          h(
            'span',
            { className: 'wps-sync-row-meta' },
            id ? h('code', { key: 'id', className: 'wps-sync-code' }, id) : null,
            meta.map((text, index) => h('span', { key: 'meta-' + index }, text)),
            h('span', { key: 'last' }, lastText),
          ),
          item && item.lastError ? h('span', { className: 'wps-sync-row-error', title: item.lastError }, t('row.error', { detail: item.lastError })) : null,
        ),
        h(
          'div',
          { className: 'wps-sync-row-actions' },
          h(Switch, {
            checked: !!(item && item.auto),
            disabled: autoBusy,
            busy: autoBusy,
            label: t('row.auto'),
            ariaLabel: t('row.autoAria', { title: props.title }),
            onChange: (next) => store.setAuto(props.kind, id, next, props.title),
          }),
          h(
            Button,
            {
              size: 'sm',
              busy: uploadBusy,
              disabled: !props.canWrite,
              icon: 'upload',
              title: props.canWrite ? uploadLabel : t('section.root.required'),
              ariaLabel: uploadLabel,
              onClick: () => store.upload(props.kind, id, props.title),
            },
            t('action.upload'),
          ),
        ),
      )
    }

    function SessionsCard(props) {
      const t = props.t
      const state = props.state
      const searchId = useId()
      const [query, setQuery] = useState('')
      const [expanded, setExpanded] = useState(false)
      const filtered = useMemo(() => {
        const term = query.trim().toLowerCase()
        if (!term) return state.sessions
        return state.sessions.filter((session) => {
          return session.title.toLowerCase().indexOf(term) !== -1 || session.id.toLowerCase().indexOf(term) !== -1
        })
      }, [state.sessions, query])
      const visible = expanded ? filtered : filtered.slice(0, ROW_LIMIT)
      return h(
        Card,
        {
          title: t('section.sessions.title'),
          help: t('section.sessions.description'),
          actions: h(Badge, { tone: 'muted' }, t('list.count', { count: state.sessions.length })),
        },
        h(
          'div',
          { className: 'wps-sync-search' },
          h('label', { className: 'wps-sync-sr-only', htmlFor: searchId }, t('list.search')),
          h(TextInput, {
            id: searchId,
            value: query,
            onChange: setQuery,
            placeholder: t('list.search'),
            ariaLabel: t('a11y.search'),
          }),
        ),
        state.sessions.length === 0
          ? h(EmptyState, { title: t('list.empty.sessions') })
          : filtered.length === 0
            ? h(EmptyState, { title: t('list.noMatch') })
            : h(
                'ul',
                { className: 'wps-sync-list' },
                visible.map((session) =>
                  h(SyncRow, {
                    key: session.id,
                    t,
                    kind: 'session',
                    id: session.id,
                    title: session.title,
                    canWrite: props.canWrite,
                    localeId: props.localeId,
                  }),
                ),
              ),
        filtered.length > ROW_LIMIT
          ? h(
              'div',
              { className: 'wps-sync-more' },
              h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setExpanded(!expanded) },
                expanded ? t('action.showLess') : t('action.showAll'),
              ),
              h('span', { className: 'wps-sync-help' }, t('list.capped', { shown: visible.length, total: filtered.length })),
            )
          : null,
      )
    }

    function WorkspacesCard(props) {
      const t = props.t
      const state = props.state
      const [expanded, setExpanded] = useState(false)
      const visible = expanded ? state.workspaces : state.workspaces.slice(0, ROW_LIMIT)
      return h(
        Card,
        {
          title: t('section.workspaces.title'),
          help: t('section.workspaces.description'),
          actions: h(Badge, { tone: 'muted' }, t('list.count', { count: state.workspaces.length })),
        },
        state.workspaces.length === 0
          ? h(EmptyState, { title: t('list.empty.workspaces') })
          : h(
              'ul',
              { className: 'wps-sync-list' },
              visible.map((workspace) =>
                h(SyncRow, {
                  key: workspace.id,
                  t,
                  kind: 'workspace',
                  id: workspace.id,
                  title: workspace.title,
                  canWrite: props.canWrite,
                  localeId: props.localeId,
                  meta: workspace.path ? [workspace.path] : [],
                }),
              ),
            ),
        state.workspaces.length > ROW_LIMIT
          ? h(
              'div',
              { className: 'wps-sync-more' },
              h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setExpanded(!expanded) },
                expanded ? t('action.showLess') : t('action.showAll'),
              ),
              h('span', { className: 'wps-sync-help' }, t('list.capped', { shown: visible.length, total: state.workspaces.length })),
            )
          : null,
      )
    }

    function TasksCard(props) {
      const t = props.t
      const state = props.state
      const item = {
        auto: state.tasks.auto,
        lastSyncAt: state.tasks.lastSyncAt,
        lastResult: state.tasks.lastResult,
        lastError: state.tasks.lastError,
      }
      return h(
        Card,
        {
          title: t('tasks.title'),
          help: t('tasks.description'),
          actions: h(Badge, { tone: 'muted' }, t('list.count', { count: state.tasks.count })),
        },
        h(
          'ul',
          { className: 'wps-sync-list' },
          h(SyncRow, {
            key: 'tasks',
            t,
            kind: 'tasks',
            id: '',
            title: t('tasks.rowTitle'),
            item,
            canWrite: props.canWrite,
            localeId: props.localeId,
            meta: [],
          }),
        ),
      )
    }

    function RootSection(props) {
      const t = props.t
      const state = props.state
      const snap = useWpsStore()
      const [value, setValue] = useState(state.syncRootDir || '')
      const [localError, setLocalError] = useState(null)
      const manualId = useId()
      const busy = !!snap.busy.root
      useEffect(() => {
        // Adopt a root saved from the session header or re-detected on refresh.
        setValue(state.syncRootDir || '')
      }, [state.syncRootDir])
      const valid = state.syncRootValid === true
      const invalid = state.syncRootValid === false
      const statusLabel = valid ? t('section.root.valid') : invalid ? t('section.root.invalid') : t('section.root.unverified')
      const statusTone = valid ? 'ok' : invalid ? 'error' : 'muted'

      async function choose() {
        setLocalError(null)
        const picked = await pickDirectory(t)
        if (picked.status === 'ok') {
          setValue(picked.path)
        } else if (picked.status === 'unavailable') {
          setLocalError(t('root.pickerUnavailable'))
        } else if (picked.status === 'error') {
          setLocalError(t('root.pickerFailed', { detail: errorText(picked.error, t) }))
        }
      }

      async function save() {
        const dir = value.trim()
        if (!dir) {
          setLocalError(t('root.invalidPath'))
          return
        }
        setLocalError(null)
        await store.setRoot(dir)
      }

      return h(
        Card,
        {
          title: t('section.root.title'),
          help: t('section.root.description'),
          actions: h(
            'span',
            { className: 'wps-sync-chip', title: t('a11y.rootStatus') },
            h('span', { className: 'wps-sync-dot wps-sync-dot--' + (valid ? 'ok' : invalid ? 'error' : 'warn') }),
            statusLabel,
          ),
        },
        h(
          'div',
          { className: 'wps-sync-kv' },
          h('span', { className: 'wps-sync-kv-label' }, t('section.root.current')),
          h(
            'div',
            { className: 'wps-sync-root-line' },
            h('code', { className: 'wps-sync-code' }, state.syncRootDir || t('section.root.notSet')),
            h(Badge, { tone: statusTone }, statusLabel),
          ),
        ),
        invalid ? h(Banner, { tone: 'warn', title: t('section.root.invalid') }, t('section.root.invalidWarning')) : null,
        state.detectedRootDir && state.detectedRootDir !== state.syncRootDir
          ? h(
              'div',
              { className: 'wps-sync-kv' },
              h('span', { className: 'wps-sync-kv-label' }, t('section.root.detected')),
              h(
                'div',
                { className: 'wps-sync-root-line' },
                h('code', { className: 'wps-sync-code' }, state.detectedRootDir),
                h(Button, { variant: 'ghost', size: 'sm', onClick: () => setValue(state.detectedRootDir) }, t('section.root.useDetected')),
              ),
            )
          : null,
        h(
          'div',
          { className: 'wps-sync-field' },
          h('label', { className: 'wps-sync-field-label', htmlFor: manualId }, t('section.root.manual')),
          h(
            'div',
            { className: 'wps-sync-field-row' },
            h(TextInput, {
              id: manualId,
              value,
              mono: true,
              invalid: !!localError,
              placeholder: t('section.root.placeholder'),
              onChange: (next) => {
                setValue(next)
                if (localError) setLocalError(null)
              },
            }),
            h(Button, { icon: 'folder', disabled: busy, onClick: choose }, t('action.chooseFolder')),
            h(Button, { variant: 'primary', busy: busy, onClick: save }, t('action.save')),
          ),
          h('p', { className: 'wps-sync-field-hint' }, t('section.root.hint')),
        ),
        localError ? h(Banner, { tone: 'error' }, localError) : null,
        h('p', { className: 'wps-sync-help' }, t('section.root.wpsHint')),
      )
    }

    function QueueCard(props) {
      const t = props.t
      const queue = props.state.queue
      return h(
        Card,
        {
          title: t('section.queue.title'),
          help: t('section.queue.description'),
          actions: h(Badge, { tone: queue.length ? 'brand' : 'muted' }, t('queue.count', { count: queue.length })),
        },
        queue.length === 0
          ? h(EmptyState, { title: t('queue.idle') })
          : h(
              'ul',
              { className: 'wps-sync-queue', 'aria-label': t('a11y.queue') },
              queue.map((job, index) =>
                h(
                  'li',
                  { key: job.key + '-' + index, className: 'wps-sync-queue-row' },
                  h(Badge, { tone: queueTone(job.state) }, queueStateLabel(t, job.state)),
                  h('span', null, job.kind ? kindLabel(t, job.kind) : t('queue.unknown')),
                  job.title ? h('code', { className: 'wps-sync-code' }, job.title) : null,
                  job.startedAt ? h('span', { className: 'wps-sync-help' }, formatTime(job.startedAt, props.localeId)) : null,
                  job.error ? h('span', { className: 'wps-sync-text-error' }, job.error) : null,
                ),
              ),
            ),
      )
    }

    function ErrorsCard(props) {
      const t = props.t
      const errors = props.state.errors.slice(-5)
      return h(
        Card,
        {
          title: t('section.errors.title'),
          actions: h(Badge, { tone: 'warn' }, t('list.count', { count: props.state.errors.length })),
        },
        h(
          'ul',
          { className: 'wps-sync-plain-list' },
          errors.map((entry, index) =>
            h(
              'li',
              { key: 'error-' + index, className: 'wps-sync-error-row' },
              h('span', null, entry.message),
              entry.at ? h('time', null, formatTime(entry.at, props.localeId)) : null,
            ),
          ),
        ),
      )
    }

    function RemoteDevice(props) {
      const t = props.t
      const snap = useWpsStore()
      const device = props.device
      const own = !!props.state.device && !!device.id && props.state.device.id === device.id
      const deviceName = device.name || device.id || t('panel.unknownDevice')
      return h(
        'div',
        { className: 'wps-sync-device' },
        h(
          'div',
          { className: 'wps-sync-device-head' },
          h('span', { className: 'wps-sync-device-name' }, deviceName),
          device.id ? h('code', { className: 'wps-sync-code' }, device.id) : null,
          own ? h(Badge, { tone: 'brand' }, t('remote.ownDevice')) : null,
          h('span', { className: 'wps-sync-help' }, t('list.count', { count: device.items.length })),
        ),
        device.items.length === 0
          ? h('p', { className: 'wps-sync-help' }, t('list.empty.remoteItems'))
          : h(
              'ul',
              { className: 'wps-sync-list' },
              device.items.map((item, index) => {
                const busy = !!snap.busy[pullKey(device.id, item.kind, item.id)]
                const label = t('row.pullAria', { title: item.title, device: deviceName })
                const canPull = props.canWrite && !!device.id && !own
                const title = own ? t('remote.ownDevice') : !device.id ? t('remote.noDevice') : !props.canWrite ? t('section.root.required') : label
                return h(
                  'li',
                  { key: item.kind + ':' + item.id + ':' + index, className: 'wps-sync-row' },
                  h(
                    'div',
                    { className: 'wps-sync-row-main' },
                    h('span', { className: 'wps-sync-row-title', title: item.title }, item.title),
                    h(
                      'span',
                      { className: 'wps-sync-row-meta' },
                      h(Badge, { key: 'kind', tone: 'muted' }, kindLabel(t, item.kind)),
                      h('code', { key: 'id', className: 'wps-sync-code' }, item.id),
                      item.version ? h('span', { key: 'ver' }, t('remote.version', { version: item.version })) : null,
                      item.updatedAt ? h('span', { key: 'upd' }, t('remote.updated', { time: formatTime(item.updatedAt, props.localeId) })) : null,
                      item.size ? h('span', { key: 'size' }, formatBytes(item.size, props.localeId)) : null,
                    ),
                  ),
                  h(
                    'div',
                    { className: 'wps-sync-row-actions' },
                    h(
                      Button,
                      {
                        size: 'sm',
                        busy,
                        disabled: !canPull,
                        icon: 'download',
                        title,
                        ariaLabel: label,
                        onClick: () => store.pull(device.id, item.kind, item.id, item.version, item.title),
                      },
                      t('action.pull'),
                    ),
                  ),
                )
              }),
            ),
      )
    }

    function RemoteSection(props) {
      const t = props.t
      const snap = useWpsStore()
      const scanning = snap.remotePhase === 'loading'
      const remote = snap.remote
      const error = snap.remoteError
      const canScan = props.canWrite
      return h(
        Card,
        {
          title: t('section.remote.title'),
          help: t('section.remote.description'),
          actions: h(
            Button,
            {
              size: 'sm',
              busy: scanning,
              disabled: !canScan,
              title: canScan ? t('section.remote.title') : t('section.root.required'),
              onClick: () => store.loadRemote().catch(() => {}),
            },
            scanning ? t('action.scanning') : t('action.scan'),
          ),
        },
        error && !scanning ? h(Banner, { tone: 'error', title: t('error.remote') }, errorText(error, t)) : null,
        !remote
          ? scanning
            ? h('div', { className: 'wps-sync-loading' }, h(Spinner), t('action.scanning'))
            : h(EmptyState, { title: t('remote.empty') })
          : remote.devices.length === 0
            ? h(EmptyState, { title: t('remote.empty') })
            : remote.devices.map((device, index) =>
                h(RemoteDevice, {
                  key: (device.id || 'device') + '-' + index,
                  t,
                  state: props.state,
                  device,
                  localeId: props.localeId,
                  canWrite: props.canWrite,
                }),
              ),
      )
    }

    function ImportRow(props) {
      const t = props.t
      const imp = props.imp
      const isWorkspace = imp.kind === 'workspace'
      const title = imp.title || imp.id || imp.importId
      const meta = [
        imp.deviceName ? t('imports.from', { device: imp.deviceName }) : '',
        imp.importedAt ? t('imports.imported', { time: formatTime(imp.importedAt, props.localeId) }) : '',
        imp.size ? formatBytes(imp.size, props.localeId) : '',
      ].filter(Boolean)
      return h(
        'li',
        { className: 'wps-sync-row' },
        h(
          'div',
          { className: 'wps-sync-row-main' },
          h('span', { className: 'wps-sync-row-title', title }, title),
          h(
            'span',
            { className: 'wps-sync-row-meta' },
            h(Badge, { key: 'kind', tone: isWorkspace ? 'brand' : 'muted' }, kindLabel(t, imp.kind)),
            h('code', { key: 'id', className: 'wps-sync-code' }, imp.id || imp.importId),
            meta.map((text, index) => h('span', { key: 'meta-' + index }, text)),
          ),
        ),
        h(
          'div',
          { className: 'wps-sync-row-actions' },
          isWorkspace
            ? h(Button, { size: 'sm', icon: 'folder', onClick: () => props.onRestore(imp) }, t('action.restore'))
            : h(
                Button,
                {
                  size: 'sm',
                  icon: 'file',
                  ariaLabel: t('a11y.viewArchive', { title }),
                  onClick: () => props.onBrowse(imp),
                },
                t('action.browse'),
              ),
        ),
      )
    }

    function ImportsSection(props) {
      const t = props.t
      const imports = props.state.imports
      const [expanded, setExpanded] = useState(false)
      const visible = expanded ? imports : imports.slice(0, IMPORT_LIMIT)
      return h(
        Card,
        {
          title: t('section.imports.title'),
          help: t('section.imports.description'),
          actions: h(Badge, { tone: 'muted' }, t('list.count', { count: imports.length })),
        },
        imports.length === 0
          ? h(EmptyState, { title: t('list.empty.imports') })
          : h(
              'ul',
              { className: 'wps-sync-list' },
              visible.map((imp, index) =>
                h(ImportRow, {
                  key: imp.importId + '-' + index,
                  t,
                  imp,
                  localeId: props.localeId,
                  onBrowse: props.onBrowse,
                  onRestore: props.onRestore,
                }),
              ),
            ),
        imports.length > IMPORT_LIMIT
          ? h(
              'div',
              { className: 'wps-sync-more' },
              h(
                Button,
                { variant: 'ghost', size: 'sm', onClick: () => setExpanded(!expanded) },
                expanded ? t('action.showLess') : t('action.showAll'),
              ),
            )
          : null,
      )
    }

    function ArchiveViewer(props) {
      const t = props.t
      const imp = props.imp
      const localeId = getLocaleId()
      const [reloadToken, setReloadToken] = useState(0)
      const [phase, setPhase] = useState('loading')
      const [files, setFiles] = useState([])
      const [selected, setSelected] = useState('')
      const [content, setContent] = useState('')
      const [binary, setBinary] = useState(false)
      const [truncated, setTruncated] = useState(false)
      const [error, setError] = useState(null)
      const alive = useRef(true)
      const seq = useRef(0)

      useEffect(
        () => () => {
          alive.current = false
        },
        [],
      )

      const loadFile = useCallback(
        async (path) => {
          const id = ++seq.current
          setSelected(path)
          setPhase('loading')
          setError(null)
          try {
            const payload = await store.archive(imp.importId, path)
            if (!alive.current || seq.current !== id) return
            const normalized = normalizeArchive(payload)
            setContent(normalized.content || '')
            setBinary(normalized.binary === true)
            setTruncated(normalized.truncated)
            setPhase('ready')
          } catch (err) {
            if (!alive.current || seq.current !== id) return
            setError(err)
            setPhase('error')
          }
        },
        [imp.importId],
      )

      useEffect(() => {
        alive.current = true
        const id = ++seq.current
        setPhase('loading')
        setError(null)
        setContent('')
        setFiles([])
        setSelected('')
        setTruncated(false)
        setBinary(false)
        ;(async () => {
          try {
            const payload = await store.archive(imp.importId)
            if (!alive.current || seq.current !== id) return
            const normalized = normalizeArchive(payload)
            setFiles(normalized.files)
            if (normalized.files.length > 0) {
              const preferred = preferredArchiveFile(normalized.files, imp.kind)
              await loadFile(preferred)
            } else if (normalized.content) {
              setContent(normalized.content)
              setBinary(normalized.binary === true)
              setTruncated(normalized.truncated)
              setSelected(normalized.path)
              setPhase('ready')
            } else {
              setPhase('ready')
            }
          } catch (err) {
            if (!alive.current || seq.current !== id) return
            setError(err)
            setPhase('error')
          }
        })()
        return () => {
          seq.current += 1
        }
      }, [imp.importId, reloadToken, loadFile])

      const shown = content.length > MAX_PREVIEW_CHARS ? content.slice(0, MAX_PREVIEW_CHARS) : content
      const capped = truncated || content.length > MAX_PREVIEW_CHARS
      return h(
        Card,
        {
          className: 'wps-sync-archive',
          title: t('archive.title', { title: imp.title || imp.id || imp.importId }),
          actions: h(IconButton, { label: t('archive.close'), icon: 'close', onClick: props.onClose }),
        },
        h(Banner, { tone: 'info', title: t('archive.readOnly') }),
        error && phase === 'error' ? h(Banner, { tone: 'error', title: t('archive.loadError') }, errorText(error, t)) : null,
        h(
          'div',
          { className: 'wps-sync-archive-grid' },
          files.length > 0
            ? h(
                'div',
                null,
                h('p', { className: 'wps-sync-help' }, t('archive.files')),
                h(
                  'ul',
                  { className: 'wps-sync-filelist' },
                  files.map((file, index) =>
                    h(
                      'li',
                      { key: file.path + '-' + index },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'wps-sync-file',
                          'aria-current': selected === file.path ? 'true' : undefined,
                          title: file.path,
                          onClick: () => loadFile(file.path),
                        },
                        h(Icon, { name: 'file' }),
                        h('span', { className: 'wps-sync-file-path' }, file.path),
                        file.size ? h('span', { className: 'wps-sync-file-size' }, formatBytes(file.size, localeId)) : null,
                      ),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'wps-sync-card-body' },
            phase === 'loading'
              ? h('div', { className: 'wps-sync-loading' }, h(Spinner), t('archive.loading'))
              : phase === 'error'
                ? h(Button, { size: 'sm', onClick: () => setReloadToken((value) => value + 1) }, t('action.retry'))
                : binary
                  ? h(EmptyState, { title: t('archive.binary') })
                  : shown
                    ? h('pre', { className: 'wps-sync-pre', tabIndex: 0, 'aria-label': t('a11y.archiveContent') }, shown)
                    : files.length === 0
                      ? h(EmptyState, { title: t('archive.noFiles') })
                      : h(EmptyState, { title: t('archive.emptyContent') }),
            capped ? h('p', { className: 'wps-sync-help' }, t('archive.truncated')) : null,
            phase === 'ready' && files.length === 0 && !shown ? h('p', { className: 'wps-sync-help' }, t('archive.selectFile')) : null,
          ),
        ),
      )
    }

    function RestoreDialog(props) {
      const t = props.t
      const imp = props.imp
      const snap = useWpsStore()
      const [target, setTarget] = useState('')
      const [conflict, setConflict] = useState('skip')
      const [localError, setLocalError] = useState(null)
      const [result, setResult] = useState(null)
      const radioName = useId()
      const targetId = useId()
      const busy = !!snap.busy['restore:' + imp.importId]
      const state = snap.state
      const root = state ? state.syncRootDir : ''
      const summary = result ? summarizeRestore(result) : null

      async function choose() {
        setLocalError(null)
        const picked = await pickDirectory(t)
        if (picked.status === 'ok') {
          setTarget(picked.path)
        } else if (picked.status === 'unavailable') {
          setLocalError(t('root.pickerUnavailable'))
        } else if (picked.status === 'error') {
          setLocalError(t('root.pickerFailed', { detail: errorText(picked.error, t) }))
        }
      }

      async function submit() {
        if (busy) return
        const value = target.trim()
        if (!value) {
          setLocalError(t('restore.needTarget'))
          return
        }
        if (!isAbsolutePath(value)) {
          setLocalError(t('restore.needAbsolute'))
          return
        }
        if (root && isPathInside(value, root)) {
          setLocalError(t('restore.insideRoot'))
          return
        }
        setLocalError(null)
        const outcome = await store.restore(imp.importId, value, conflict)
        if (outcome.ok) setResult(outcome.value || {})
        else setLocalError(errorText(outcome.error, t))
      }

      const footer = result
        ? [h(Button, { key: 'close', variant: 'primary', onClick: props.onClose }, t('action.close'))]
        : [
            h(Button, { key: 'cancel', disabled: busy, onClick: props.onClose }, t('action.cancel')),
            h(
              Button,
              { key: 'submit', variant: 'primary', busy, onClick: submit },
              busy ? t('restore.working') : t('restore.submit'),
            ),
          ]

      return h(
        Modal,
        {
          open: true,
          t,
          busy,
          title: t('restore.title'),
          description: t('restore.description'),
          onClose: props.onClose,
          footer,
        },
        h(
          'div',
          { className: 'wps-sync-kv' },
          h('span', { className: 'wps-sync-kv-label' }, t('restore.archive')),
          h('code', { className: 'wps-sync-code' }, imp.title || imp.importId),
        ),
        imp.deviceName
          ? h(
              'div',
              { className: 'wps-sync-kv' },
              h('span', { className: 'wps-sync-kv-label' }, t('restore.device')),
              h('span', null, imp.deviceName),
            )
          : null,
        summary
          ? h(
              'div',
              null,
              h(Banner, {
                tone: 'ok',
                title: t('restore.doneSimple'),
              }),
              summary.hasCounts
                ? h('p', { className: 'wps-sync-help' }, t('restore.done', { restored: summary.restored, skipped: summary.skipped, renamed: summary.renamed }))
                : null,
              h('p', { className: 'wps-sync-help' }, target.trim()),
            )
          : [
              h(
                'div',
                { className: 'wps-sync-field', key: 'target' },
                h('label', { className: 'wps-sync-field-label', htmlFor: targetId }, t('restore.target')),
                h(
                  'div',
                  { className: 'wps-sync-field-row' },
                  h(TextInput, {
                    id: targetId,
                    value: target,
                    mono: true,
                    autoFocus: true,
                    disabled: busy,
                    invalid: !!localError,
                    placeholder: t('restore.targetPlaceholder'),
                    onChange: (next) => {
                      setTarget(next)
                      if (localError) setLocalError(null)
                    },
                  }),
                  h(Button, { icon: 'folder', disabled: busy, onClick: choose }, t('action.chooseFolder')),
                ),
                h('p', { className: 'wps-sync-field-hint' }, t('restore.targetHint')),
              ),
              h(
                'fieldset',
                { className: 'wps-sync-fieldset', key: 'conflict' },
                h('legend', { className: 'wps-sync-field-label' }, t('restore.conflict')),
                ['skip', 'rename'].map((value) =>
                  h(
                    'label',
                    { key: value, className: 'wps-sync-radio' },
                    h('input', {
                      type: 'radio',
                      name: radioName,
                      value,
                      checked: conflict === value,
                      disabled: busy,
                      onChange: () => setConflict(value),
                    }),
                    h(
                      'span',
                      { className: 'wps-sync-radio-text' },
                      h('span', null, t(value === 'skip' ? 'restore.skip' : 'restore.rename')),
                      h('span', { className: 'wps-sync-radio-hint' }, t(value === 'skip' ? 'restore.skipHint' : 'restore.renameHint')),
                    ),
                  ),
                ),
                h('p', { className: 'wps-sync-field-hint' }, t('restore.noOverwrite')),
              ),
              target && root && isPathInside(target, root)
                ? h(Banner, { key: 'inside', tone: 'warn', title: t('restore.insideRoot') })
                : null,
              localError ? h(Banner, { key: 'error', tone: 'error' }, localError) : null,
            ],
      )
    }

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined') console.error('[wps-sync] panel render failed', error, info)
      }

      render() {
        if (!this.state.error) return this.props.children
        const t = this.props.t || fallbackTranslate
        const detail = this.state.error && this.state.error.message ? String(this.state.error.message) : String(this.state.error)
        return h(
          'div',
          { className: 'wps-sync-panel' },
          h(Banner, { tone: 'error', title: t('error.render') }, h('code', { className: 'wps-sync-code' }, detail)),
        )
      }
    }

    class HeaderBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        if (typeof console !== 'undefined') console.error('[wps-sync] header render failed', error, info)
      }

      render() {
        if (!this.state.error) return this.props.children
        const t = this.props.t || fallbackTranslate
        return h('span', { className: 'wps-sync-header-caption wps-sync-header-error', role: 'alert' }, t('header.error'))
      }
    }

    function MainPanel(props) {
      const t = pickT(props)
      const snap = useWpsStore()
      const localeId = getLocaleId()
      const [archiveImport, setArchiveImport] = useState(null)
      const [restoreImport, setRestoreImport] = useState(null)
      const state = snap.state
      const canWrite = !!state && !!state.syncRootDir && state.syncRootValid !== false
      const refreshing = snap.phase === 'loading' || snap.phase === 'refreshing'
      const notice = snap.notice
      const actionError = snap.actionError

      useEffect(() => {
        store.ensureLoaded()
      }, [])

      useEffect(() => {
        if (!snap.state || snap.remotePhase !== 'idle') return
        if (!snap.state.syncRootDir || snap.state.syncRootValid === false) return
        store.loadRemote().catch(() => {})
      }, [snap.state, snap.remotePhase])

      const topbar = h(
        'header',
        { className: 'wps-sync-top' },
        h(
          'div',
          { className: 'wps-sync-top-text' },
          h('h2', { className: 'wps-sync-title' }, t('panel.title')),
          h('p', { className: 'wps-sync-sub' }, t('panel.description')),
        ),
        h(
          'div',
          { className: 'wps-sync-top-actions' },
          state && state.device
            ? h(
                'span',
                { className: 'wps-sync-chip', title: state.device.name || state.device.id },
                h(Icon, { name: 'device' }),
                h('span', null, t('panel.device') + ': ' + (state.device.name || state.device.id)),
              )
            : null,
          h(
            Button,
            {
              variant: 'ghost',
              busy: refreshing,
              icon: 'refresh',
              title: t('a11y.refresh'),
              ariaLabel: t('a11y.refresh'),
              onClick: () => store.refresh().catch(() => {}),
            },
            t('action.refresh'),
          ),
          h(
            Button,
            {
              variant: 'primary',
              busy: !!snap.busy['upload:all'],
              disabled: !canWrite,
              icon: 'upload',
              title: canWrite ? t('a11y.uploadAll') : t('section.root.required'),
              ariaLabel: t('a11y.uploadAll'),
              onClick: () => store.uploadAll(),
            },
            t('action.uploadAll'),
          ),
        ),
      )

      const content = state
        ? [
            h(RootSection, { key: 'root', t, state }),
            h(
              'div',
              { key: 'status', className: 'wps-sync-columns' },
              h(QueueCard, { key: 'queue', t, state, localeId }),
              state.errors.length ? h(ErrorsCard, { key: 'errors', t, state, localeId }) : null,
            ),
            h(
              'div',
              { key: 'lists', className: 'wps-sync-columns' },
              h(SessionsCard, { key: 'sessions', t, state, localeId, canWrite }),
              h(WorkspacesCard, { key: 'workspaces', t, state, localeId, canWrite }),
              h(TasksCard, { key: 'tasks', t, state, localeId, canWrite }),
            ),
            h(RemoteSection, { key: 'remote', t, state, localeId, canWrite }),
            h(ImportsSection, {
              key: 'imports',
              t,
              state,
              localeId,
              canWrite,
              onBrowse: setArchiveImport,
              onRestore: setRestoreImport,
            }),
            archiveImport
              ? h(ArchiveViewer, { key: 'archive-' + archiveImport.importId, t, imp: archiveImport, onClose: () => setArchiveImport(null) })
              : null,
            restoreImport
              ? h(RestoreDialog, { key: 'restore-' + restoreImport.importId, t, imp: restoreImport, onClose: () => setRestoreImport(null) })
              : null,
          ]
        : snap.phase === 'error'
          ? h(
              Card,
              { title: t('error.title') },
              h(Banner, { tone: 'error' }, errorText(snap.error, t)),
              h(Button, { onClick: () => store.refresh().catch(() => {}) }, t('action.retry')),
            )
          : h('div', { className: 'wps-sync-card' }, h('div', { className: 'wps-sync-loading' }, h(Spinner), t('panel.loading')))

      return h(
        'section',
        {
          className: 'wps-sync-panel',
          'aria-label': t('a11y.panel'),
          'aria-busy': refreshing ? 'true' : undefined,
        },
        topbar,
        notice
          ? h(Banner, {
              tone: notice.tone || 'ok',
              title: t(notice.key, notice.params),
              onDismiss: store.dismissNotice,
              dismissLabel: t('action.dismiss'),
            })
          : null,
        actionError
          ? h(
              Banner,
              {
                tone: 'error',
                title: t(actionError.key),
                onDismiss: store.dismissActionError,
                dismissLabel: t('action.dismiss'),
              },
              errorText(actionError.error, t),
            )
          : null,
        content,
      )
    }

    function SessionSyncAction(props) {
      const t = pickT(props)
      const sessionId = asString(props.sessionId) || asString(props.session && props.session.id)
      const snap = useWpsStore()
      useEffect(() => {
        store.ensureLoaded()
      }, [])
      if (!sessionId) return null
      const state = snap.state
      const session = state ? state.sessions.filter((entry) => entry.id === sessionId)[0] : null
      const label = session ? session.title : sessionId
      const item = itemFor(state, 'session', sessionId)
      const uploadBusy = !!snap.busy[uploadKey('session', sessionId)]
      const autoBusy = !!snap.busy[autoKey('session', sessionId)]
      const canUpload = !!state && !!state.syncRootDir && state.syncRootValid !== false
      const lastSyncAt = item ? item.lastSyncAt : 0
      const lastSync = lastSyncAt ? formatTime(lastSyncAt, getLocaleId()) : ''
      const unknownSession = !!state && !item
      const scopeError =
        snap.actionError &&
        (snap.actionError.busyKey === uploadKey('session', sessionId) || snap.actionError.busyKey === autoKey('session', sessionId))
      const loadError = snap.phase === 'error' && !state
      let caption = ''
      let captionTitle = ''
      let captionError = false
      if (loadError) {
        caption = t('header.stateError')
        captionTitle = errorText(snap.error, t)
        captionError = true
      } else if (scopeError) {
        caption = t('header.error')
        captionTitle = errorText(scopeError.error, t)
        captionError = true
      } else if (item && item.lastError) {
        caption = t('header.error')
        captionTitle = item.lastError
        captionError = true
      } else if (!state) {
        caption = t('header.busy')
      } else if (!item) {
        caption = t('header.notListed')
        captionTitle = t('header.notListed')
      } else {
        caption = lastSync ? t('sync.status.ok') : t('sync.status.never')
        captionTitle = lastSync ? t('header.lastSync', { time: lastSync }) : t('header.never')
      }
      const uploadTitle = canUpload
        ? t('header.upload') + (lastSync ? ' · ' + t('header.lastSync', { time: lastSync }) : '')
        : t('section.root.required')
      return h(
        'div',
        { className: 'wps-sync-header', role: 'group', 'aria-label': t('header.group') },
        h(
          'button',
          {
            type: 'button',
            className: 'wps-sync-header-btn',
            title: uploadTitle,
            'aria-label': t('header.upload'),
            'aria-busy': uploadBusy ? 'true' : undefined,
            disabled: !canUpload || uploadBusy,
            onClick: () => store.upload('session', sessionId, label),
          },
          uploadBusy ? h('span', { className: 'wps-sync-spinner', 'aria-hidden': 'true' }) : h(Icon, { name: 'upload', size: 16 }),
        ),
        h(
          'span',
          { className: 'wps-sync-header-switch' },
          h(Switch, {
            checked: item ? !!item.auto : true,
            disabled: autoBusy || !state || !item,
            busy: autoBusy,
            label: t('header.auto'),
            ariaLabel: t('header.autoAria'),
            onChange: (next) => store.setAuto('session', sessionId, next, label),
          }),
        ),
        loadError
          ? h(IconButton, { label: t('header.retry'), icon: 'refresh', onClick: () => store.refresh().catch(() => {}) })
          : null,
        caption
          ? h(
              'span',
              {
                className: 'wps-sync-header-caption' + (unknownSession ? ' wps-sync-header-caption-wide' : '') + (captionError ? ' wps-sync-header-error' : ''),
                role: captionError ? 'alert' : undefined,
                title: captionTitle,
              },
              caption,
            )
          : null,
      )
    }

    function WpsSyncPanel(props) {
      return h(PanelBoundary, { t: pickT(props) }, h(MainPanel, props))
    }

    function WpsSyncSessionAction(props) {
      return h(HeaderBoundary, { t: pickT(props) }, h(SessionSyncAction, props))
    }

    function apply(ctx) {
      appCtx = ctx || null
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'ui-wps-sync: dictionaries')
      ctx.effect(() => ensureStyles(), 'ui-wps-sync: styles')
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-wps-sync-bundle',
            locale: NS,
          },
          WpsSyncPanel,
        ),
      )
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'wps-sync-session',
            order: 5,
            locale: NS,
          },
          WpsSyncSessionAction,
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    }
  },
})