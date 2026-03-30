/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/search', 'N/log'], function(record, search, log) {

    var ITEM_SUBLIST = 'item';

    // change field ids here
    var PARENT_COLUMN_FIELD = 'custcol_parent_item';
    var ITEM_RELATED_COMPONENTS_FIELD = 'custitem_related_components';
    var VENDOR_SPECIAL_ORDER_FIELD = 'custentity_special_order_vendor';

    function afterSubmit(context) {
        try {
            if (context.type !== context.UserEventType.CREATE &&
                context.type !== context.UserEventType.EDIT) {
                return;
            }

            var poId = context.newRecord.id;
            if (!poId) return;

            log.debug('START', 'PO Id: ' + poId);

            var approvalStatus = context.newRecord.getValue({ fieldId: 'approvalstatus' });
            log.debug('PO Approval Status', approvalStatus);

            // standard NetSuite: 1 = Pending Approval
            if (String(approvalStatus) !== '1') {
                log.debug('STOP', 'PO is not Pending Approval');
                return;
            }

            var vendorId = context.newRecord.getValue({ fieldId: 'entity' });
            if (!vendorId) {
                log.debug('STOP', 'Vendor not found on PO');
                return;
            }

            var vendorData = search.lookupFields({
                type: search.Type.VENDOR,
                id: vendorId,
                columns: [VENDOR_SPECIAL_ORDER_FIELD]
            });

            var isSpecialVendor = vendorData[VENDOR_SPECIAL_ORDER_FIELD] === true;
            log.debug('Vendor Check', {
                vendorId: vendorId,
                specialOrderVendor: isSpecialVendor
            });

            if (!isSpecialVendor) {
                log.debug('STOP', 'Vendor is not marked as special order vendor');
                return;
            }

            var poRec = record.load({
                type: record.Type.PURCHASE_ORDER,
                id: poId,
                isDynamic: false
            });

            var lineCount = poRec.getLineCount({ sublistId: ITEM_SUBLIST });
            log.debug('Line Count', lineCount);

            if (!lineCount) return;

            var poLines = [];
            var itemIdsObj = {};
            var i;

            for (i = 0; i < lineCount; i++) {
                var itemId = poRec.getSublistValue({
                    sublistId: ITEM_SUBLIST,
                    fieldId: 'item',
                    line: i
                });

                if (!itemId) continue;

                poLines.push({
                    line: i,
                    itemId: String(itemId)
                });

                itemIdsObj[String(itemId)] = true;
            }

            var itemIds = [];
            for (var key in itemIdsObj) {
                itemIds.push(key);
            }

            log.debug('Unique Item Count', itemIds.length);

            if (!itemIds.length) return;

            var parentMap = getParentComponentMap(itemIds);
            var parentLineIndexes = [];

            // find all parent lines first
            for (i = 0; i < poLines.length; i++) {
                var lineItemId = poLines[i].itemId;
                if (parentMap[lineItemId] && hasKeys(parentMap[lineItemId])) {
                    parentLineIndexes.push(i);
                }
            }

            log.debug('Parent Line Indexes', JSON.stringify(parentLineIndexes));

            if (!parentLineIndexes.length) {
                log.debug('STOP', 'No parent lines found');
                return;
            }

            var hasChanges = false;

            // optional: clear all values first so old wrong mappings are removed
            for (i = 0; i < poLines.length; i++) {
                clearField(poRec, poLines[i].line);
            }

            // process one parent block at a time
            for (i = 0; i < parentLineIndexes.length; i++) {
                var parentStartIndex = parentLineIndexes[i];
                var parentEndIndex = (i + 1 < parentLineIndexes.length) ? parentLineIndexes[i + 1] - 1 : poLines.length - 1;

                var parentLineObj = poLines[parentStartIndex];
                var parentItemId = parentLineObj.itemId;
                var childMap = parentMap[parentItemId];

                log.debug('Processing Parent Block', {
                    parentItemId: parentItemId,
                    startLine: parentLineObj.line,
                    endLine: poLines[parentEndIndex].line
                });

                // only check lines between current parent and next parent
                var j;
                for (j = parentStartIndex + 1; j <= parentEndIndex; j++) {
                    var childLineObj = poLines[j];
                    var childItemId = childLineObj.itemId;

                    if (childMap[childItemId]) {
                        poRec.setSublistValue({
                            sublistId: ITEM_SUBLIST,
                            fieldId: PARENT_COLUMN_FIELD,
                            line: childLineObj.line,
                            value: parentItemId
                        });

                        hasChanges = true;

                        log.debug('Child Updated', {
                            line: childLineObj.line,
                            childItemId: childItemId,
                            parentItemId: parentItemId
                        });
                    }
                }
            }

            if (hasChanges) {
                var savedId = poRec.save({
                    enableSourcing: false,
                    ignoreMandatoryFields: true
                });

                log.audit('PO Saved', 'PO updated successfully. Id: ' + savedId);
            } else {
                log.debug('NO CHANGES', 'No child lines needed update');
            }

        } catch (e) {
            log.error({
                title: 'afterSubmit Error',
                details: e
            });
        }
    }

    function getParentComponentMap(itemIds) {
        var resultMap = {};

        search.create({
            type: search.Type.ITEM,
            filters: [
                ['internalid', 'anyof', itemIds]
            ],
            columns: [
                'internalid',
                ITEM_RELATED_COMPONENTS_FIELD
            ]
        }).run().each(function(result) {
            var parentId = String(result.getValue({ name: 'internalid' }));
            var components = result.getValue({ name: ITEM_RELATED_COMPONENTS_FIELD });

            resultMap[parentId] = buildChildMap(components);

            log.debug('Parent Components', {
                parentId: parentId,
                components: components
            });

            return true;
        });

        return resultMap;
    }

    function buildChildMap(value) {
        var map = {};

        if (!value) return map;

        var arr = String(value).split(',');
        var i;

        for (i = 0; i < arr.length; i++) {
            var id = String(arr[i]).replace(/\s+/g, '');
            if (id) {
                map[id] = true;
            }
        }

        return map;
    }

    function hasKeys(obj) {
        for (var key in obj) {
            return true;
        }
        return false;
    }

    function clearField(poRec, line) {
        try {
            poRec.setSublistValue({
                sublistId: ITEM_SUBLIST,
                fieldId: PARENT_COLUMN_FIELD,
                line: line,
                value: ''
            });
        } catch (e) {
            // ignore clear error
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});