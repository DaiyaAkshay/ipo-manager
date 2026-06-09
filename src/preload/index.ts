import { contextBridge, ipcRenderer } from 'electron';

const api = {
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    unlock: (password: string) => ipcRenderer.invoke('vault:unlock', password),
    lock: () => ipcRenderer.invoke('vault:lock'),
    changePassword: (currentPassword: string, newPassword: string) =>
      ipcRenderer.invoke('vault:changePassword', { currentPassword, newPassword }),
    reset: (confirmation: string, password?: string) =>
      ipcRenderer.invoke('vault:reset', { confirmation, password })
  },
  gmail: {
    status: () => ipcRenderer.invoke('gmail:status'),
    connect: () => ipcRenderer.invoke('gmail:connect'),
    setCredentials: (rawJson: string) => ipcRenderer.invoke('gmail:setCredentials', rawJson),
    clearCredentials: () => ipcRenderer.invoke('gmail:clearCredentials')
  },
  captchaAi: {
    status: () => ipcRenderer.invoke('captchaAi:status'),
    setKey: (apiKey: string) => ipcRenderer.invoke('captchaAi:setKey', 'anthropic', apiKey),
    clearKey: () => ipcRenderer.invoke('captchaAi:clearKey', 'anthropic'),
    getUsage: () => ipcRenderer.invoke('captchaAi:getUsage'),
    setConsent: (consented: boolean) => ipcRenderer.invoke('captchaAi:setConsent', consented),
    setCap: (cap: number) => ipcRenderer.invoke('captchaAi:setCap', cap),
    resetTodayCounter: () => ipcRenderer.invoke('captchaAi:resetTodayCounter')
  },
  families: {
    list: () => ipcRenderer.invoke('families:list'),
    create: (family_name: string, min_balance?: number) => ipcRenderer.invoke('families:create', { family_name, min_balance }),
    update: (id: number, family_name: string, notes?: string, min_balance?: number) => ipcRenderer.invoke('families:update', { id, family_name, notes, min_balance }),
    delete: (id: number) => ipcRenderer.invoke('families:delete', { id }),
    reorder: (ids: number[]) => ipcRenderer.invoke('families:reorder', { ids }),
    members: (familyId: number) => ipcRenderer.invoke('members:byFamily', familyId)
  },
  member: {
    detail: (memberId: number) => ipcRenderer.invoke('member:detail', memberId),
    fullDetail: (memberId: number) => ipcRenderer.invoke('member:fullDetail', memberId),
    create: (payload: any) => ipcRenderer.invoke('members:create', payload),
    update: (payload: any) => ipcRenderer.invoke('members:update', payload),
    delete: (id: number) => ipcRenderer.invoke('members:delete', { id }),
    reorder: (family_id: number, ids: number[]) => ipcRenderer.invoke('members:reorder', { family_id, ids })
  },
  documents: {
    pick: (docType: 'PAN' | 'AADHAAR' | 'BIRTH_CERTIFICATE' | 'CHEQUE') =>
      ipcRenderer.invoke('documents:pick', { docType }),
    download: (memberId: number, docType: 'PAN' | 'AADHAAR' | 'BIRTH_CERTIFICATE' | 'CHEQUE') =>
      ipcRenderer.invoke('documents:download', { memberId, docType })
  },
  importer: {
    pickAndRun: () => ipcRenderer.invoke('import:pickAndRun')
  },
  exporter: {
    pickAndRun: () => ipcRenderer.invoke('export:pickAndRun')
  },
  automation: {
    cancelCurrent: () => ipcRenderer.invoke('automation:cancelCurrent'),
    clearBrowserSessions: () => ipcRenderer.invoke('automation:clearBrowserSessions')
  },
  login: {
    bank: (memberId: number, bankId: number, options?: { closeAfterFetch?: boolean }) =>
      ipcRenderer.invoke('login:bank', { memberId, bankId, closeAfterFetch: !!options?.closeAfterFetch }),
    broker: (memberId: number, brokerId: number, fetchBalance = false, options?: { closeAfterFetch?: boolean }) =>
      ipcRenderer.invoke('login:broker', { memberId, brokerId, fetchBalance, closeAfterFetch: !!options?.closeAfterFetch })
  },
  reports: {
    downloadBrokerPortfolio: (memberId: number, brokerId: number) =>
      ipcRenderer.invoke('broker:downloadPortfolio', { memberId, brokerId }),
    latestBrokerPortfolio: (memberId: number, brokerId: number) =>
      ipcRenderer.invoke('broker:getLatestPortfolio', { memberId, brokerId }),
    openLatestBrokerPortfolioFolder: (memberId: number, brokerId: number) =>
      ipcRenderer.invoke('broker:openLatestPortfolioFolder', { memberId, brokerId })
  },
  ipo: {
    getMemberDraftOptions: (memberId: number) =>
      ipcRenderer.invoke('ipo:getMemberDraftOptions', { memberId }),
    listCatalog: () =>
      ipcRenderer.invoke('ipo:listCatalog'),
    refreshCatalog: () =>
      ipcRenderer.invoke('ipo:refreshCatalog'),
    prepareAuBid: (payload: {
      memberId: number;
      bankId: number;
      brokerId?: number | null;
      issueName: string;
      quantity: number;
      lotSize?: number | null;
      bidType: 'CUTOFF' | 'LIMIT';
      bidPrice: number;
    }) => ipcRenderer.invoke('ipo:prepareAuBid', payload),
    confirmAuBid: (bidRunId: number) =>
      ipcRenderer.invoke('ipo:confirmAuBid', { bidRunId }),
    listMemberBids: (memberId: number) =>
      ipcRenderer.invoke('ipo:listMemberBids', { memberId }),
    /** Push event: fires when the AU IPO browser window is closed by the user.
     *  Returns a cleanup function — call it inside useEffect's return. */
    onWindowClosed: (cb: (payload: { memberId: number }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { memberId: number }) => cb(data);
      ipcRenderer.on('ipo:ipoWindowClosed', handler);
      return () => ipcRenderer.off('ipo:ipoWindowClosed', handler);
    },
  },
  totp: {
    listZerodhaMembers: () => ipcRenderer.invoke('totp:listZerodhaMembers'),
    generate: (brokerAccountId: number) => ipcRenderer.invoke('totp:generate', { brokerAccountId }),
  },
  recharge: {
    list: () => ipcRenderer.invoke('recharge:list'),
    create: (payload: { name: string; mobile_number: string; mobile_model?: string; recharge_date?: string; validity_days?: number; notes?: string }) =>
      ipcRenderer.invoke('recharge:create', payload),
    update: (payload: { id: number; name: string; mobile_number: string; mobile_model?: string; recharge_date?: string; validity_days?: number; notes?: string }) =>
      ipcRenderer.invoke('recharge:update', payload),
    delete: (id: number) => ipcRenderer.invoke('recharge:delete', { id }),
    reorder: (ids: number[]) => ipcRenderer.invoke('recharge:reorder', { ids }),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url)
  },
  backup: {
    status: () => ipcRenderer.invoke('backup:status'),
    getConfig: () => ipcRenderer.invoke('backup:getConfig'),
    setConfig: (patch: { enabled?: boolean; folder?: string | null }) =>
      ipcRenderer.invoke('backup:setConfig', patch),
    pickFolder: () => ipcRenderer.invoke('backup:pickFolder'),
    runNow: () => ipcRenderer.invoke('backup:runNow'),
    listSnapshots: () => ipcRenderer.invoke('backup:listSnapshots'),
    listSnapshotsFromFolder: (folder: string) =>
      ipcRenderer.invoke('backup:listSnapshotsFromFolder', folder),
    restore: (snapshotId: string, sourceFolder?: string) =>
      ipcRenderer.invoke('backup:restore', { snapshotId, sourceFolder }),
    latestSnapshotId: (sourceFolder?: string) =>
      ipcRenderer.invoke('backup:latestSnapshotId', sourceFolder)
  },
  events: {
    onLocked: (cb: () => void) => ipcRenderer.on('vault:locked', cb),
    onAutoSynced: (cb: (data: { snapshotTimestamp: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { snapshotTimestamp: string }) => cb(data);
      ipcRenderer.on('vault:autoSynced', handler);
      return () => ipcRenderer.off('vault:autoSynced', handler);
    },
  },
  otp: {
    /** Called by the renderer to register a handler for when main needs an OTP. */
    onNeeded:  (cb: (data: { label: string }) => void) =>
      ipcRenderer.on('otp:needed', (_, data) => cb(data)),
    /** Called by the renderer to dismiss the dialog if main cancelled/timed out. */
    onDismiss: (cb: () => void) =>
      ipcRenderer.on('otp:dismiss', () => cb()),
    /** Submit the typed OTP back to the main process. */
    provide: (otp: string) => ipcRenderer.invoke('otp:provide', otp),
    /** Cancel the OTP request. */
    cancel:  () => ipcRenderer.invoke('otp:cancel')
  },
  updater: {
    /** Subscribe to update lifecycle events. Returns a cleanup function. */
    onStatus: (
      cb: (payload: {
        kind: 'checking' | 'available' | 'up-to-date' | 'downloading' | 'downloaded' | 'error';
        version?: string;
        percent?: number;
        message?: string;
      }) => void,
    ): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: any) => cb(data);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.off('updater:status', handler);
    },
    checkNow: () => ipcRenderer.invoke('updater:checkNow'),
    installNow: () => ipcRenderer.invoke('updater:installNow'),
    currentVersion: () => ipcRenderer.invoke('updater:currentVersion'),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type Api = typeof api;
