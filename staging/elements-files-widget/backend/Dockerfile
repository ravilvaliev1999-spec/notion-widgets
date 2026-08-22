FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY backend ./backend
COPY frontend ./frontend
ENV APP_ENV=staging
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "backend/server.mjs"]
