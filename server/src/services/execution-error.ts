/** 可理解的失败原因；保留脱敏后的原始错误，不按字符截断通知。 */
export function executionErrorMessage(raw: string): string {
  const detail=raw.replace(/\bsk-[A-Za-z0-9*_-]+/g,'[已隐藏凭据]');
  const summary=/Concurrency limit exceeded/i.test(raw)
    ? '模型服务的账号并发额度已满，本次执行未完成。请等待该账号的其他请求结束后再重试；本任务不会自动重复执行。'
    : /401|invalid_api_key|Incorrect API key/i.test(raw)
      ? '模型服务鉴权失败，请检查执行器使用的服务地址与登录凭据是否匹配。'
      : /stream disconnected|timed out|timeout/i.test(raw)
        ? '模型连接中断或超时，本次执行未完成。已有操作可能生效，请核对任务记录后再重试。'
        : '';
  return summary ? `${summary}\n原始错误：${detail}` : detail;
}
