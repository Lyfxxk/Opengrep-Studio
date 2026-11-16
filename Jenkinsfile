pipeline {
  agent any

  options {
    buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
    disableConcurrentBuilds()
    timeout(time: 90, unit: 'MINUTES')
  }

  parameters {
    booleanParam(name: 'DEPLOY', defaultValue: true, description: '构建镜像并在健康检查通过后替换本地运行的 opengrep-studio 容器；节点需可访问 docker')
    booleanParam(name: 'BUILD_DOCKER', defaultValue: false, description: '仅在 DEPLOY=false 时单独使用：构建镜像并检查容器启动，不换装')
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

    stage('构建前端') {
      steps {
        sh 'npm --prefix code run build'
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
      echo '前端构建和镜像流程已完成；部署时已执行容器健康检查。'
    }
    failure {
      echo '构建或部署失败：请查看失败阶段的输出和容器日志。'
    }
  }
}
