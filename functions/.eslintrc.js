module.exports = {
    root: true,
    env: {
        es2020: true,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 2020,
    },
    extends: [
        "eslint:recommended",
    ],
    rules: {
        "no-unused-vars": "warn",
        "no-console": "off",
    },
};
