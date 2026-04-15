FROM ghcr.io/puppeteer/puppeteer:24.6.0
WORKDIR /app
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
RUN mkdir -p /app/data
EXPOSE 3001
CMD ["node", "server.js"]
