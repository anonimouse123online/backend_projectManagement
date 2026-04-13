const webService = {
  async getData() {
    // Your web-specific logic here
    return { message: 'web data' };
  },

  async submitData(payload) {
    // Process payload from web client
    return { received: payload };
  },
};

module.exports = webService;