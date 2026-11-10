// components/ 里共用组件自己的文案：新版本提示。
import { defineMessages } from '@/i18n';

export const componentsMessages = defineMessages({
  en: {
    updateShort: 'New version',
    updateLong: 'New version. Reload to use it.',
    reload: 'Reload',
    dismissUpdate: 'Do not show this version again',
    // 桌面 App 的一键更新（state/shellUpdate.ts）。
    appUpdate: {
      available: (version: string) => `New version ${version}`,
      update: 'Update',
      later: 'Remind me tomorrow',
      downloading: (percent: number) => `Downloading the update: ${percent}%`,
      installing: 'Installing the update. The app opens again when it is done.',
      installingShort: 'Installing the update',
      retry: 'Try Again',
      // 失败的那句话后面接上 App 给的原因（报错原文，例如 HTTP 404）。
      failedWithReason: (message: string, reason: string) => `${message} Reason: ${reason}`,
      failed: {
        download_failed: 'The update did not download.',
        checksum_mismatch: 'The downloaded update is damaged.',
        mount_failed: 'The update file did not open.',
        app_invalid: 'The update file is not a correct copy of the app.',
        not_writable: 'The app cannot replace itself. Move it to the Applications folder.',
        replace_failed: 'The app could not replace itself.',
      },
    },
  },
  zh: {
    updateShort: '有新版本',
    updateLong: '有新版本，刷新后生效',
    reload: '刷新',
    dismissUpdate: '不再提示这个版本',
    appUpdate: {
      available: (version) => `新版本 ${version}`,
      update: '更新',
      later: '明天再提醒',
      downloading: (percent) => `正在下载更新：${percent}%`,
      installing: '正在安装更新，装好以后 App 会重新打开。',
      installingShort: '正在安装更新',
      retry: '重试',
      failedWithReason: (message, reason) => `${message}原因：${reason}`,
      failed: {
        download_failed: '更新没有下载下来。',
        checksum_mismatch: '下载的更新文件损坏了。',
        mount_failed: '更新文件打不开。',
        app_invalid: '更新文件里的 App 不对。',
        not_writable: 'App 换不了自己。请把它移到「应用程序」文件夹。',
        replace_failed: 'App 没能换成新版本。',
      },
    },
  },
});
