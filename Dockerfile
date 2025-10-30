FROM ghcr.io/puppeteer/puppeteer:21.6.1

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application files
COPY . .

# Expose port
EXPOSE 4000

# Puppeteer is already configured in this image
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Start the application
CMD ["node", "web-WhatsApp.js"]
