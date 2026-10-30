import {
  isOnBehalfOwnerActionNotification, isOwnerActionNotificationKind, ownerActionRefOfNotification, type NotificationDto,
} from '@pi-lead-child/protocol';

// 侧栏的通知卡（2026-10-15 用户决定，Jarvis 模式）：委派出去的事都先到 Lead，由 Lead 决定怎样告诉用户，
// 系统自己不往界面上推。侧栏只放三种：Lead 用 notify_user 决定推给用户的（lead_notice），
// Lead 不能工作时系统兜底推的（deliveredVia 是 fallback，包括那条「Lead 现在不可用」的汇总），
// 和高风险的主人操作（工单 15：系统直接推，带「不是我」；daemon 推送之前它还是 pending，也要显示）。
// 主人操作是这个客户端自己的凭证做的（用户刚在这里点的）：这里不放，会话里只有一行记录。
// 只是这个客户端不显示：通知不确认，手机、Slack 照常收到。
// Lead 在对话里代你做的操作（工单 03 审查 M5）不是你刚在这里点的：发出那一轮的设备上也显示，带「撤销」。
export function userOutboxNotifications(
  notifications: readonly NotificationDto[],
  options: { ownBindingId?: number | null } = {},
): NotificationDto[] {
  return notifications.filter((notification) => {
    if (isOwnerActionNotificationKind(notification.kind)) {
      if (isOnBehalfOwnerActionNotification(notification)) return true;
      const ref = ownerActionRefOfNotification(notification);
      return !(ref && options.ownBindingId != null && ref.bindingId === options.ownBindingId);
    }
    return notification.kind === 'lead_notice' || notification.deliveredVia === 'fallback';
  });
}
