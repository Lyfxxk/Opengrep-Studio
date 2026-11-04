// CD 流水线：push → 全量测试 → 构建镜像 → 容器内健康自检通过后替换 opengrep-studio 容器（8787）
// 阶段划分（5 个）：环境准备 → 后端质量门禁 → 前端质量门禁 → 端到端回归 → 镜像构建与部署
// 检查项与旧的 10 阶段版本完全一致，只是把「工具链自检+依赖安装」「引擎准备+E2E」「镜像冒烟+部署」各自并成一个阶段，
// 并删掉了与部署阶段重复的那次 docker build（旧「镜像构建与冒烟」是「部署上线」的真子集）。
pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
    disableConcurrentBuilds()
    timeout(time: 90, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'RUN_E2E', defaultValue: true, description: '运行真实引擎端到端回归；首次执行需联网下载约 50MB 引擎并做 SHA256 校验')
    booleanParam(name: 'DEPLOY', defaultValue: true, description: '测试通过后构建镜像并替换本地运行的 opengrep-studio 容器（http://localhost:8787）；节点需可访问 docker')
    booleanParam(name: 'BUILD_DOCKER', defaultValue: false, description: '仅在 DEPLOY=false 时单独使用：构建镜像并做容器冒烟，只验证不换装')
  }

  environment {
    NODE_MIN_VERSION = '22.12.0'
    npm_config_audit = 'false'
    npm_config_fund = 'false'
    DEPLOY_ENABLED = "${params.DEPLOY}"
    BUILD_DOCKER_ENABLED = "${params.BUILD_DOCKER}"
    // 部署成功后保留最近几个构建号的镜像（含本次），更早的自动清理，避免旧镜像无限堆积
    IMAGE_KEEP = '3'
  }

  stages {
    stage('环境准备') {
      steps {
        sh '''
          set -euo pipefail

          node -e '
            const need = process.env.NODE_MIN_VERSION.split(".").map(Number);
            const cur = process.versions.node.split(".").map(Number);
            const lower = cur[0] < need[0]
              || (cur[0] === need[0] && cur[1] < need[1])
              || (cur[0] === need[0] && cur[1] === need[1] && cur[2] < need[2]);
            if (lower) {
              console.error(`[jenkins] 当前 Node ${process.versions.node} 低于要求的 ${process.env.NODE_MIN_VERSION}：请在该节点安装 Node 22.12 及以上（或按 .nvmrc 安装 26）后重试`);
              process.exit(1);
            }
            console.log(`[jenkins] Node ${process.versions.node} 满足 >= ${process.env.NODE_MIN_VERSION}`);
          '
          node -v
          npm -v
          git --version

          npm --prefix server ci
          npm --prefix code ci
        '''
      }
    }

    stage('后端质量门禁') {
      steps {
        sh '''
          set -euo pipefail
          npm --prefix server run typecheck
          npm --prefix server test
          npm --prefix server run i18n:check
          npm run test-packs
        '''
      }
    }

    stage('前端质量门禁') {
      steps {
        sh '''
          set -euo pipefail
          npm --prefix code run lint
          npm --prefix code run build
        '''
      }
    }

    stage('端到端回归') {
      when { expression { params.RUN_E2E != false } }
      steps {
        // 引擎准备幂等（已在且哈希一致时直接跳过），并入本阶段省掉一个空转阶段
        retry(2) {
          sh 'npm run setup:engine'
        }
        sh '''
          set -euo pipefail

          health() {
            node -e "fetch('http://127.0.0.1:' + process.argv[1] + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" "$1"
          }

          TMP="${WORKSPACE_TMP:-${WORKSPACE}/.tmp}"
          DATA_DIR="$TMP/e2e-data"
          CUSTOM_RULES_DIR="$TMP/e2e-rules-custom"
          rm -rf "$DATA_DIR" "$CUSTOM_RULES_DIR"
          mkdir -p "$DATA_DIR" "$CUSTOM_RULES_DIR"

          PORT="$(node -e "const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { console.log(s.address().port); s.close(); })")"
          export HOST=127.0.0.1 PORT DATA_DIR CUSTOM_RULES_DIR

          (
            cd server && exec node --import tsx src/index.ts
          ) > server.log 2>&1 &
          SERVER_PID=$!

          cleanup() {
            if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2> /dev/null; then
              kill -TERM "$SERVER_PID" 2> /dev/null || true
              for _ in $(seq 1 15); do
                kill -0 "$SERVER_PID" 2> /dev/null || break
                sleep 1
              done
              kill -KILL "$SERVER_PID" 2> /dev/null || true
            fi
          }
          trap cleanup EXIT

          ready=0
          for _ in $(seq 1 60); do
            if health "$PORT"; then
              ready=1
              break
            fi
            if ! kill -0 "$SERVER_PID" 2> /dev/null; then
              echo "[jenkins] 后端进程提前退出，日志尾部："
              tail -n 80 server.log || true
              exit 1
            fi
            sleep 2
          done

          if [ "$ready" -ne 1 ]; then
            echo "[jenkins] 后端 120 秒内未通过 /api/health，日志尾部："
            tail -n 80 server.log || true
            exit 1
          fi

          echo "[jenkins] 后端就绪：http://127.0.0.1:${PORT}"
          BASE_URL="http://127.0.0.1:${PORT}" npm run e2e 2>&1 | tee e2e.log
        '''
      }
    }

    stage('镜像构建与部署') {
      steps {
        sh '''
          set -euo pipefail

          health_in() {
            docker exec "$1" node -e "fetch('http://127.0.0.1:8787/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" > /dev/null 2>&1
          }

          if [ "$DEPLOY_ENABLED" != "true" ]; then
            if [ "$BUILD_DOCKER_ENABLED" != "true" ]; then
              echo "[jenkins] DEPLOY=false 且 BUILD_DOCKER=false，跳过镜像构建。"
              exit 0
            fi

            # 只验证不换装：随机端口 + 容器内自检，不绑宿主机 8787，避免与线上容器冲突
            IMAGE="opengrep-studio:ci-${BUILD_NUMBER}"
            NAME="opengrep-studio-smoke-${BUILD_NUMBER}"
            cleanup() {
              docker rm -f "$NAME" > /dev/null 2>&1 || true
              docker rmi -f "$IMAGE" > /dev/null 2>&1 || true
            }
            trap cleanup EXIT

            docker build -t "$IMAGE" .
            docker run -d --name "$NAME" "$IMAGE" > /dev/null

            ready=0
            for _ in $(seq 1 45); do
              if health_in "$NAME"; then ready=1; break; fi
              if [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2> /dev/null || echo false)" != "true" ]; then break; fi
              sleep 2
            done

            if [ "$ready" -ne 1 ]; then
              echo "[jenkins] 容器冒烟失败，容器日志："
              docker logs "$NAME" || true
              exit 1
            fi
            echo "[jenkins] 容器冒烟通过（未换装）。"
            exit 0
          fi

          IMAGE="opengrep-studio:latest"
          STAGING="opengrep-studio-staging"

          docker build -t "opengrep-studio:${BUILD_NUMBER}" -t "$IMAGE" .

          # 临时容器不挂数据卷：应用用 SQLite 存储，避免与线上实例并发写同一库文件
          docker rm -f "$STAGING" > /dev/null 2>&1 || true
          docker run -d --name "$STAGING" "$IMAGE" > /dev/null

          ready=0
          for _ in $(seq 1 30); do
            if health_in "$STAGING"; then ready=1; break; fi
            if [ "$(docker inspect -f '{{.State.Running}}' "$STAGING" 2> /dev/null || echo false)" != "true" ]; then break; fi
            sleep 3
          done

          if [ "$ready" -ne 1 ]; then
            echo "[jenkins] 新容器健康检查未通过，保留旧容器，部署中止。容器日志："
            docker logs --tail 80 "$STAGING" || true
            docker rm -f "$STAGING" > /dev/null 2>&1 || true
            exit 1
          fi

          docker rm -f opengrep-studio > /dev/null 2>&1 || true
          docker rm -f "$STAGING" > /dev/null 2>&1 || true
          docker run -d --name opengrep-studio --restart unless-stopped -p 127.0.0.1:8787:8787 -v ogstudio-data:/data "$IMAGE" > /dev/null

          final=0
          for _ in $(seq 1 30); do
            if health_in opengrep-studio; then final=1; break; fi
            sleep 3
          done

          if [ "$final" -ne 1 ]; then
            echo "[jenkins] 正式容器启动后自检失败，容器日志："
            docker logs --tail 80 opengrep-studio || true
            exit 1
          fi

          # 按构建号留档并只保留最近 IMAGE_KEEP 个，替代原先删不掉带 tag 镜像的 image prune
          docker images opengrep-studio --format "{{.Tag}}" \
            | grep -E '^[0-9]+$' | sort -rn | tail -n +$((IMAGE_KEEP + 1)) \
            | while read -r tag; do
                docker rmi "opengrep-studio:${tag}" > /dev/null 2>&1 || true
              done
          docker image prune -f > /dev/null 2>&1 || true

          echo "[jenkins] 部署完成：http://localhost:8787（镜像 opengrep-studio:${BUILD_NUMBER}，保留最近 ${IMAGE_KEEP} 个构建号）"
        '''
      }
    }
  }

  post {
    success {
      echo '构建通过：后端类型检查/单测/i18n/规则包、前端 lint/构建均已通过，按参数启用的真实引擎 E2E 与镜像冒烟也全部通过。'
    }
    failure {
      echo '构建失败：请查看失败 stage 的输出，后端启动日志与 E2E 日志已归档为 server.log / e2e.log。'
    }
    always {
      archiveArtifacts artifacts: 'e2e.log, server.log', allowEmptyArchive: true, fingerprint: true
    }
  }
}
