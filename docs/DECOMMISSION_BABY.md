# Baby Decommission

After standalone acceptance:

1. export raw migration and receipt evidence;
2. freeze Baby mutations;
3. revoke Baby gateway signing authority and OAuth material;
4. stop and disable Baby services;
5. remove Baby MCP routing;
6. preserve a time-bounded offline rollback archive;
7. scan process, socket, route, key use, executable imports, state reads, tool catalog, and operation names;
8. reboot the VPS;
9. run complete standalone acceptance;
10. remove the offline archive after the chosen rollback window.

Historical provenance, licenses, migration records, and evidence remain.
