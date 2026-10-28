/** Public view of a line: never includes secrets. */
export const lineView = {
  id: true,
  businessId: true,
  phoneNumberId: true,
  wabaId: true,
  appId: true,
  displayPhone: true,
  active: true,
  createdAt: true,
} as const;
