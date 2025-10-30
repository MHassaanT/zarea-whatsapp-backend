FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Switch to root to set permissions
ENV NODE_ENV=production
USER root

# Set working directory
WORKDIR /app

# Create auth directory and set permissions
RUN mkdir -p /app/.wwebjs_auth && \
    chown -R pptruser:pptruser /app

# Copy package files
COPY --chown=pptruser:pptruser package*.json ./

# Switch back to pptruser
USER pptruser

# Install dependencies
RUN npm install --production

# Copy application files
COPY --chown=pptruser:pptruser . .

# Expose port
EXPOSE 4000

# Puppeteer is already configured
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Start the application
CMD ["node", "web-WhatsApp.js"]
