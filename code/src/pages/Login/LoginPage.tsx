import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { login, validateCredentials } from '@/lib/auth';
import LanguageMenu from '@/components/LanguageMenu';
import logoUrl from '@/assets/images/logo.png';
import './login.css';

type ErrorField = 'username' | 'password';

export default function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('123456');
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState<ErrorField | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [success, setSuccess] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number[]>([]);

  // 登录成功态的两个延时（800ms 校验 + 900ms 跳转）必须在卸载时清掉
  useEffect(() => () => {
    for (const timer of timerRef.current) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    document.title = t('login.title');
    return () => {
      document.title = t('title.app');
    };
  }, [t]);

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
      showError(t('login.errorUsername'), 'username');
      return;
    }
    if (!password) {
      showError(t('login.errorPassword'), 'password');
      return;
    }
    if (!validateCredentials(trimmedName, password)) {
      showError(t('login.errorInvalid'), 'password');
      return;
    }

    clearError();
    setSubmitting(true);
    // 本地账号校验即登录接口：写入登录态后展示成功态，再进入工作台
    // 定时器登记到 ref 并在卸载时清掉：用户在 800+900ms 窗口内手动离开时，不能被拽回工作台
    timerRef.current.push(
      window.setTimeout(() => {
        login(trimmedName);
        setSubmitting(false);
        setSuccess(true);
        timerRef.current.push(window.setTimeout(() => navigate('/dashboard'), 900));
      }, 800),
    );
  };

  const togglePassword = () => {
    setShowPassword((prev) => !prev);
    passwordRef.current?.focus();
  };

  return (
    <div className="login-shell">
      {/* 左侧：暗色展示面板 */}
      <section className="brand-panel" aria-label={t('login.introPanel')}>
        <div className="brand-hero">
          <p className="hero-eyebrow">// LOCAL-FIRST CODE AUDIT</p>
          <h1>
            {t('login.heroTitle1')}
            <em>{t('login.heroTitleEm')}</em>
            {t('login.heroTitle2')}
          </h1>
        </div>

        <div
          className="term"
          role="img"
          aria-label={t('login.termAria')}
        >
          <div className="term-bar">
            <span className="term-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="term-title">{t('login.termTitle')}</span>
          </div>
          <div className="term-body">
            <div className="term-line">
              <span className="p">$</span> opengrep scan ./payment-service --rules default
            </div>
            <div className="term-line">
              <span className="ok">✓</span> <span className="dim">{t('login.termEngineLoaded')}</span> 18{' '}
              <span className="dim">{t('login.termRules')}</span>
            </div>
            <div className="term-line">
              <span className="sev sev-high">{t('login.termHigh')}</span>
              <span className="rule-name">{t('login.termRuleCredentials')}</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/auth/</span>
                <span className="file">credentials.ts</span>
                <span className="ln">:42</span>
              </span>
            </div>
            <div className="term-line">
              <span className="sev sev-mid">{t('login.termMedium')}</span>
              <span className="rule-name">{t('login.termRuleSql')}</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/api/</span>
                <span className="file">orders.ts</span>
                <span className="ln">:87</span>
              </span>
            </div>
            <div className="term-line">
              <span className="sev sev-mid">{t('login.termMedium')}</span>
              <span className="rule-name">{t('login.termRuleAuthz')}</span>
              <span className="leader" />
              <span className="path">
                <span className="dir">src/api/</span>
                <span className="file">upload.ts</span>
                <span className="ln">:15</span>
              </span>
            </div>
            <div className="term-line">
              <span className="ok">✓</span> <span className="dim">{t('login.termScanDone')}</span> 1,284{' '}
              <span className="dim">{t('login.termFiles')}</span> 3 <span className="dim">{t('login.termRisks')}</span> 3.2s
            </div>
            <div className="term-line">
              <span className="p">$</span> <span className="caret" />
            </div>
          </div>
        </div>

        <div className="steps">
          <div className="step">
            <div className="step-num">01</div>
            <h3>{t('login.step1Title')}</h3>
            <p>{t('login.step1Desc')}</p>
          </div>
          <div className="step">
            <div className="step-num">02</div>
            <h3>{t('login.step2Title')}</h3>
            <p>{t('login.step2Desc')}</p>
          </div>
          <div className="step">
            <div className="step-num">03</div>
            <h3>{t('login.step3Title')}</h3>
            <p>{t('login.step3Desc')}</p>
          </div>
          <div className="step">
            <div className="step-num">04</div>
            <h3>{t('login.step4Title')}</h3>
            <p>{t('login.step4Desc')}</p>
          </div>
        </div>
      </section>

      {/* 右侧：登录表单 */}
      <section className="form-panel" aria-label={t('login.formPanel')}>
        {/* 未登录用户唯一可见的语言切换入口（应用内切换在 Header） */}
        <LanguageMenu className="lang-switch" />
        <div className="form-col">
          <div className="form-brand">
            <img className="brand-logo" src={logoUrl} alt="" aria-hidden="true" />
            <div>
              <div className="brand-name-row">
                <div className="brand-name">Opengrep Studio</div>
                <span className="ver-badge">v{__APP_VERSION__}</span>
              </div>
              <div className="brand-tagline" style={{ fontSize: '20px' }}>
                {t('app.tagline')}
              </div>
            </div>
          </div>

          {!success ? (
            <div>
              <form onSubmit={handleSubmit} noValidate>
                <div className="field">
                  <label htmlFor="login-username" style={{ fontSize: '20.5px' }}>
                    {t('login.username')}
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
                    {t('login.password')}
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
                      aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
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
                      {t('login.submitting')}
                    </>
                  ) : (
                    t('login.submit')
                  )}
                </button>
              </form>
            </div>
          ) : (
            <div className="success-state">
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
              <h2>{t('login.successTitle')}</h2>
              <p>{t('login.successDesc')}</p>
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
