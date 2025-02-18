/*
 * This program and the accompanying materials are made available under the terms of the *
 * Eclipse Public License v2.0 which accompanies this distribution, and is available at *
 * https://www.eclipse.org/legal/epl-v20.html                                      *
 *                                                                                 *
 * SPDX-License-Identifier: EPL-2.0                                                *
 *                                                                                 *
 * Copyright Contributors to the Zowe Project.                                     *
 *                                                                                 *
 */

/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */

import { AbstractCredentialManager, ImperativeError, SecureCredential, Logger } from "@zowe/imperative";
import { getZoweDir } from "../profiles/ProfilesCache";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import * as globals from "../globals";

declare const __webpack_require__: typeof require;
declare const __non_webpack_require__: typeof require;

/**
 * Keytar - Securely store user credentials in the system keychain
 *
 * @export
 * @class KeytarCredentialManager
 */
export class KeytarCredentialManager extends AbstractCredentialManager {
    /**
     * Reference to the lazily loaded keytar module.
     *
     * @public
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    public static keytar: any;

    /**
     * Combined list of services that credentials may be stored under
     */
    private allServices: string[] = [
        globals.SETTINGS_SCS_DEFAULT,
        globals.SCS_ZOWE_PLUGIN,
        globals.SCS_BRIGHTSIDE,
        globals.SCS_ZOWE_CLI,
        globals.SCS_BROADCOM_PLUGIN,
    ];

    /**
     * Preferred service name to store credentials with
     */
    private preferredService: string;

    /**
     * Pass-through to the superclass constructor.
     *
     * @param {string} service The service string to send to the superclass constructor.
     * @param {string} displayName The display name for this credential manager to send to the superclass constructor
     */
    // eslint-disable-next-line @typescript-eslint/explicit-member-accessibility
    constructor(service: string, displayName: string) {
        // Always ensure that a manager instantiates the super class, even if the
        // constructor doesn't do anything. Who knows what things might happen in
        // the abstract class initialization in the future.
        super(service, displayName);

        if (this.allServices.indexOf(service) === -1) {
            this.allServices.push(service);
        }

        this.preferredService = service;
    }

    public static getSecurityModules(moduleName: string, isTheia: boolean): NodeRequire | undefined {
        let imperativeIsSecure = false;
        const r = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
        try {
            const fileName = path.join(getZoweDir(), "settings", "imperative.json");
            let settings;
            if (fs.existsSync(fileName)) {
                settings = JSON.parse(fs.readFileSync(fileName, "utf8")) as Record<string, unknown>;
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            const baseValue = settings.overrides as Record<string, unknown>;
            const value1 = baseValue.CredentialManager;
            const value2 = baseValue["credential-manager"];
            imperativeIsSecure =
                (typeof value1 === "string" && value1.length > 0) || (typeof value2 === "string" && value2.length > 0);
        } catch (error) {
            return undefined;
        }
        if (imperativeIsSecure) {
            // Workaround for Theia issue (https://github.com/eclipse-theia/theia/issues/4935)
            const appRoot = isTheia ? process.cwd() : vscode.env.appRoot;
            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return r(`${appRoot}/node_modules/${moduleName}`);
            } catch (err) {
                /* Do nothing */
            }
            try {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-return
                return r(`${appRoot}/node_modules.asar/${moduleName}`);
            } catch (err) {
                /* Do nothing */
            }
        }
        return undefined;
    }

    /**
     * Calls the keytar deletePassword service with {@link DefaultCredentialManager#service} and the
     * account passed to the function by Imperative.
     *
     * @param {string} account The account for which to delete the password
     *
     * @returns {Promise<void>} A promise that the function has completed.
     *
     * @throws {@link ImperativeError} if keytar is not defined.
     * @throws {@link ImperativeError} when keytar.deletePassword returns false.
     */
    protected async deleteCredentials(account: string): Promise<void> {
        if (!(await this.deleteCredentialsHelper(account))) {
            Logger.getAppLogger().debug("errorHandling.deleteCredentials", "Unable to delete credentials.");
        }
    }

    /**
     * Calls the keytar getPassword service with {@link DefaultCredentialManager#service} and the
     * account passed to the function by Imperative.
     *
     * @param {string} account The account for which to get credentials
     * @param {boolean} optional Set to true if failure to find credentials should be ignored
     * @returns {Promise<SecureCredential>} A promise containing the credentials stored in keytar.
     *
     * @throws {@link ImperativeError} if keytar is not defined.
     * @throws {@link ImperativeError} when keytar.getPassword returns null or undefined.
     */
    protected async loadCredentials(account: string, optional?: boolean): Promise<SecureCredential> {
        // Helper function to handle all breaking changes
        // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
        const loadHelper = async (service: string) => {
            let secureValue: string = await KeytarCredentialManager.keytar.getPassword(service, account);
            // Handle user vs username case // Zowe v1 -> v2 (i.e. @brightside/core@2.x -> @zowe/cli@6+ )
            if (secureValue == null && account.endsWith("_username")) {
                secureValue = await KeytarCredentialManager.keytar.getPassword(
                    service,
                    account.replace("_username", "_user")
                );
            }
            // Handle pass vs password case // Zowe v0 -> v1 (i.e. @brightside/core@1.x -> @brightside/core@2.x)
            if (secureValue == null && account.endsWith("_pass")) {
                secureValue = await KeytarCredentialManager.keytar.getPassword(
                    service,
                    account.replace("_pass", "_password")
                );
            }
            return secureValue;
        };

        let password;

        // Check for stored credentials under each of the known services
        // We will stop checking once we find them somewhere
        for (const service of this.allServices) {
            password = await loadHelper(service);

            if (password != null) {
                break;
            }
        }

        // Throw an error if credentials could not be found
        if (password == null && !optional) {
            throw new ImperativeError({
                msg: "Unable to load credentials.",
                additionalDetails: this.getMissingEntryMessage(account),
            });
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return password;
    }

    /**
     * Calls the keytar setPassword service with {@link DefaultCredentialManager#service} and the
     * account and credentials passed to the function by Imperative.
     *
     * @param {string} account The account to set credentials
     * @param {SecureCredential} credentials The credentials to store
     *
     * @returns {Promise<void>} A promise that the function has completed.
     *
     * @throws {@link ImperativeError} if keytar is not defined.
     */
    protected async saveCredentials(account: string, credentials: SecureCredential): Promise<void> {
        await this.deleteCredentialsHelper(account, true);
        await KeytarCredentialManager.keytar.setPassword(this.preferredService, account, credentials);
    }

    private async deleteCredentialsHelper(account: string, skipPreferredService?: boolean): Promise<boolean> {
        let wasDeleted = false;
        for (const service of this.allServices) {
            if (skipPreferredService && service === this.preferredService) {
                continue;
            }
            if (await KeytarCredentialManager.keytar.deletePassword(service, account)) {
                wasDeleted = true;
            }
        }
        return wasDeleted;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    private getMissingEntryMessage(account: string) {
        return (
            `Could not find an entry in the credential vault for the following:\n` +
            `  Service = ${this.allServices.join(", ")}\n` +
            `  Account = ${account}\n\n` +
            `Possible Causes:\n` +
            `  This could have been caused by any manual removal of credentials from your vault.\n\n` +
            `Resolutions:\n` +
            `  Recreate the credentials in the vault for the particular service in the vault.`
        );
    }
}

/**
 * Imports the neccesary security modules
 */
export function getSecurityModules(moduleName: string, isTheia: boolean): NodeModule | undefined {
    const r = typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;
    // Workaround for Theia issue (https://github.com/eclipse-theia/theia/issues/4935)
    const appRoot = isTheia ? process.cwd() : vscode.env.appRoot;
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return r(`${appRoot}/node_modules/${moduleName}`);
    } catch (err) {
        /* Do nothing */
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return r(`${appRoot}/node_modules.asar/${moduleName}`);
    } catch (err) {
        /* Do nothing */
    }
    return undefined;
}
