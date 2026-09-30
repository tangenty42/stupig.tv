# About

This is the repository for our official website, built with our custom Markdown-powered full-stack CMS.

We are the smart **Stupig**s!

Learn more about us at our official website [stupig.tv](https://www.stupig.tv).

# Deployment

- Wire up your MySQL and Redis instance
- Wire up your EMQX WebSocket endpoint like `http://127.0.0.1:8083` to `<your-domain>/mqtt`
- Add CronJob to run storage cleanup script: `cd /app && flock -n /tmp/stupig-storage.lock /usr/local/bin/pnpm run storage:cleanup -- --delete --grace-hours=168 >> /var/log/stupig-storage.log 2>&1`
- Set `client_max_body_size 2m;` for your gateway safety

# This is why you should always update your VSCode without reading the changelog

`POV: you click "update" in your VSCode as usual.`

the following 2 hrs:

![0](public/md/vscode/0a.png)
![0](public/md/vscode/0b.png)
![0](public/md/vscode/0c.png)

occasionally:

![1](public/md/vscode/1.png)

you:

![2](public/md/vscode/2.png)
