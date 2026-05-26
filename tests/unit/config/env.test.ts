/**
 * Unit tests — Environment configuration validation
 */

describe('Environment Configuration', () => {
    let originalEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
        // Save original environment
        originalEnv = { ...process.env };
        // Clear the require cache to reload config
        jest.resetModules();
    });

    afterEach(() => {
        // Restore original environment
        process.env = originalEnv;
    });

    describe('Required environment variables validation', () => {
        it('throws error when STELLAR_NETWORK is missing', () => {
            delete process.env.STELLAR_NETWORK;
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/Missing required environment variable: STELLAR_NETWORK/);
        });

        it('throws error when STELLAR_AGENT_SECRET_KEY is missing', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            delete process.env.STELLAR_AGENT_SECRET_KEY;
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/Missing required environment variable: STELLAR_AGENT_SECRET_KEY/);
        });

        it('throws error when VAULT_CONTRACT_ID is missing', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            delete process.env.VAULT_CONTRACT_ID;
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/Critical environment variables are missing/);
        });

        it('throws error when DATABASE_URL is missing', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            delete process.env.DATABASE_URL;
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/Critical environment variables are missing/);
        });
    });

    describe('Stellar network validation', () => {
        it('accepts valid network: testnet', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            const config = require('../../../src/config/env').config;
            expect(config.stellar.network).toBe('testnet');
        });

        it('accepts valid network: mainnet', () => {
            process.env.STELLAR_NETWORK = 'mainnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';
            process.env.NODE_ENV = 'production';

            const config = require('../../../src/config/env').config;
            expect(config.stellar.network).toBe('mainnet');
        });

        it('accepts valid network: futurenet', () => {
            process.env.STELLAR_NETWORK = 'futurenet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            const config = require('../../../src/config/env').config;
            expect(config.stellar.network).toBe('futurenet');
        });

        it('rejects invalid network', () => {
            process.env.STELLAR_NETWORK = 'invalidnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/Invalid STELLAR_NETWORK/);
        });

        it('is case-insensitive', () => {
            process.env.STELLAR_NETWORK = 'TESTNET';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            const config = require('../../../src/config/env').config;
            expect(config.stellar.network).toBe('testnet');
        });
    });

    describe('Stellar secret key validation', () => {
        it('rejects key not starting with S', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'AXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/must start with S/);
        });

        it('rejects key with incorrect length', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SSHORT';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            expect(() => {
                require('../../../src/config/env');
            }).toThrow(/invalid length/);
        });

        it('accepts valid 56-character key starting with S', () => {
            process.env.STELLAR_NETWORK = 'testnet';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            const config = require('../../../src/config/env').config;
            expect(config.stellar.agentSecretKey).toBe('SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
        });
    });

    describe('Mainnet warning', () => {
        it('warns when mainnet is used in development', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            process.env.STELLAR_NETWORK = 'mainnet';
            process.env.NODE_ENV = 'development';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            require('../../../src/config/env');

            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('CRITICAL WARNING'));
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('MAINNET'));

            consoleSpy.mockRestore();
        });

        it('does not warn when mainnet is used in production', () => {
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

            process.env.STELLAR_NETWORK = 'mainnet';
            process.env.NODE_ENV = 'production';
            process.env.STELLAR_RPC_URL = 'https://rpc.example.com';
            process.env.STELLAR_AGENT_SECRET_KEY = 'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
            process.env.VAULT_CONTRACT_ID = 'CVAULT';
            process.env.USDC_TOKEN_ADDRESS = 'CUSDC';
            process.env.ANTHROPIC_API_KEY = 'key';
            process.env.DATABASE_URL = 'postgresql://localhost/db';
            process.env.JWT_SEED = 'seed';

            require('../../../src/config/env');

            // Should not have the critical warning
            const criticalWarnings = consoleSpy.mock.calls.filter(call =>
                call[0]?.toString().includes('CRITICAL WARNING')
            );
            expect(criticalWarnings.length).toBe(0);

            consoleSpy.mockRestore();
        });
    });
});
