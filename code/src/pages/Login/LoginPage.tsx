import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { login, validateCredentials } from '@/lib/auth';
import logoUrl from '@/assets/images/logo.png';
import './login.css';

type ErrorField = 'username' | 'password';

export default function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('123456');
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<ErrorField | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = '登录 · Opengrep Studio';
    return () => {
      document.title = 'Opengrep Studio | 码审工作台';
    };
  }, []);

  const showError = (message: string, field: ErrorField) => {
    setError(message);
    setErrorField(field);
    (field === 'username' ? usernameRef : passwordRef).current?.focus();
  };

  const clearError = () => {
    setError('');
    setErrorField(null);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || success) return;
    const trimmedName = username.trim();
    if (!trimmedName) {
      showError('请输入账号', 'username');
      return;
    }
    if (!password) {
      showError('请输入密码', 'password');
      return;
    }
    if (!validateCredentials(trimmedName, password)) {
      showError('账号或密码错误', 'password');
      return;
    }

    clearError();
    setSubmitting(true);
    // 本地账号校验即登录接口：写入登录态后展示成功态，再进入工作台
    setTimeout(() => {
      login(trimmedName);
      setSubmitting(false);
      setSuccess(true);
      toast.success('登录成功，欢迎回来');
      setTimeout(() => navigate('/dashboard'), 900);
    }, 800);
  };

  const togglePassword = () => {
    setShowPassword((prev) => !prev);
    passwordRef.current?.focus();
  };

  return (
    <div className="login-shell">
      {/* 左侧：暗色展示面板 */}
      <section className="brand-panel" aria-label="产品介绍">
        <div className="brand-hero">
          <p className="hero-eyebrow">// LOCAL-FIRST CODE AUDIT</p>
          <h1>
            让隐患，先于攻击者<em>现形</em>。
          </h1>
          <p className="hero-sub">
            从导入源码到交付测试报告，规则引擎逐条比对，
            <br />
            风险直达文件与行号，四步完成一次完整审计。
          </p>
        </div>

        <div
          className="term"
          role="img"
          aria-label="审计流程演示：新建项目、导入源码、扫描标记风险、生成测试报告"
        >
          <div className="term-bar">
            <span className="term-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="term-title">opengrep · scan — 示例数据</span>
          </div>
          <div className="term-body">
            <div className="term-line">
              <span className="p">$</span> opengrep scan ./payment-service --rules default
            </div>
            <div className="term-line">
              <span className="ok">✓</span> <span className="dim">引擎就绪 · 已加载</span> 18{' '}
              <span className="dim">条规则</span>
            </div>
            <div className="term-line">
              <span className="sev sev-high">高危</span>
              <span className="rule-name">硬编码凭据</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/auth/</span>
                <span className="file">credentials.ts</span>
                <span className="ln">:42</span>
              </span>
            </div>
            <div className="term-line">
              <span className="sev sev-mid">中危</span>
              <span className="rule-name">SQL 拼接风险</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/api/</span>
                <span className="file">orders.ts</span>
                <span className="ln">:87</span>
              </span>
            </div>
            <div className="term-line">
              <span className="sev sev-mid">中危</span>
              <span className="rule-name">越权访问风险</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/api/</span>
                <span className="file">upload.ts</span>
                <span className="ln">:15</span>
              </span>
            </div>
            <div className="term-line">
              <span className="ok">✓</span> <span className="dim">扫描完成 ·</span> 1,284{' '}
              <span className="dim">个文件 ·</span> 3 <span className="dim">处风险 · 用时</span> 3.2s
            </div>
            <div className="term-line">
              <span className="p">$</span> <span className="caret" />
            </div>
          </div>
        </div>

        <div className="steps">
          <div className="step">
            <div className="step-num">01</div>
            <h3>新建审计项目</h3>
            <p>为待审计代码包建立独立空间。</p>
          </div>
          <div className="step">
            <div className="step-num">02</div>
            <h3>上传项目源码</h3>
            <p>多种形式导入，代码不经云端。</p>
          </div>
          <div className="step">
            <div className="step-num">03</div>
            <h3>逐条审阅风险</h3>
            <p>逐条核对风险清单与规则对比。</p>
          </div>
          <div className="step">
            <div className="step-num">04</div>
            <h3>查看测试报告</h3>
            <p>汇总风险等级，生成测试报告。</p>
          </div>
        </div>
      </section>

      {/* 右侧：登录表单 */}
      <section className="form-panel" aria-label="登录">
        <div className="form-col">
          <div className="form-brand">
            <img className="brand-logo" src={logoUrl} alt="" aria-hidden="true" />
            <div>
              <div className="brand-name-row">
                <div className="brand-name">Opengrep Studio</div>
                <span className="ver-badge">v{__APP_VERSION__}</span>
              </div>
              <div className="brand-tagline" style={{ fontSize: '20px' }}>
                码审工作台
              </div>
            </div>
          </div>

          {!success ? (
            <div>
              <form onSubmit={handleSubmit} noValidate>
                <div className="field">
                  <label htmlFor="login-username" style={{ fontSize: '20.5px' }}>
                    账号
                  </label>
                  <div className="input-wrap">
                    <svg
                      className="input-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4.5 20c1.4-3.1 4.2-4.8 7.5-4.8s6.1 1.7 7.5 4.8" />
                    </svg>
                    <input
                      ref={usernameRef}
                      className="input"
                      id="login-username"
                      name="username"
                      type="text"
                      maxLength={30}
                      placeholder="请输入管理员账号"
                      autoComplete="username"
                      value={username}
                      aria-invalid={errorField === 'username' ? true : undefined}
                      onChange={(event) => {
                        setUsername(event.target.value);
                        clearError();
                      }}
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="login-password" style={{ fontSize: '20.5px' }}>
                    密码
                  </label>
                  <div className="input-wrap">
                    <svg
                      className="input-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
                      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
                      <circle cx="12" cy="15.2" r="1.4" />
                    </svg>
                    <input
                      ref={passwordRef}
                      className="input"
                      id="login-password"
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      maxLength={30}
                      placeholder="请输入密码"
                      autoComplete="current-password"
                      value={password}
                      style={{ paddingRight: '52px' }}
                      aria-invalid={errorField === 'password' ? true : undefined}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        clearError();
                      }}
                    />
                    <button
                      type="button"
                      className="pw-toggle"
                      onClick={togglePassword}
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      aria-pressed={showPassword}
                    >
                      {showPassword ? (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2.5 12S6 5.8 12 5.8c1.7 0 3.2.5 4.5 1.2M21.5 12S18 18.2 12 18.2c-1.7 0-3.2-.5-4.5-1.2" />
                          <path d="M4 20 20 4" />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
                          <circle cx="12" cy="12" r="2.8" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                {error && (
                  <p className="form-error" role="alert" aria-live="polite">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 8v4.5M12 16h.01" />
                    </svg>
                    <span>{error}</span>
                  </p>
                )}

                <button type="submit" className="submit-btn" disabled={submitting}>
                  {submitting ? (
                    <>
                      <span className="spinner" aria-hidden="true" />
                      登录中…
                    </>
                  ) : (
                    '登　录'
                  )}
                </button>
              </form>
            </div>
          ) : (
            <div className="success-state show">
              <div className="success-mark" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m4.5 12.5 5 5 10-11" />
                </svg>
              </div>
              <h2>身份已确认</h2>
              <p>正在进入工作台…</p>
            </div>
          )}

          <div className="form-foot">
            <span style={{ fontSize: '15px', fontWeight: 600 }}>
              © 2026 Opengrep Studio by{' '}
              <a href="https://github.com/Lyfxxk" target="_blank" rel="noopener noreferrer">
                Lyfxxk
              </a>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}
