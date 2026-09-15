/** SF admin assume-user: `serviceaccount/{tenant}/truefoundry/tfy-system`. */
export const TFY_ASSUME_USER_HEADER = 'x-tfy-assume-user';
const TFY_SYSTEM_ASSUME_SUBJECT = 'truefoundry';
const TFY_SYSTEM_CONTROLLER = 'tfy-system';

export function tenantSystemAssumeUserHeader(tenantName: string): string {
  return `serviceaccount/${tenantName}/${TFY_SYSTEM_ASSUME_SUBJECT}/${TFY_SYSTEM_CONTROLLER}`;
}
